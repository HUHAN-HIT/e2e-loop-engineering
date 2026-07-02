/**
 * e2e-loop doctor 子命令。
 *
 * 目标是把"入口在哪、文档在不在、能不能 init"这类启动前问题变成
 * 机械 preflight, 避免按旧 Python 形态误判当前 TS monorepo。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Args } from "../args.js";
import { resolveProjectDir } from "../util.js";

interface CheckResult {
  ok: boolean;
  detail: string;
}

interface DoctorReport {
  ok: boolean;
  cwd: string;
  repo_root: string;
  checks: Record<string, CheckResult>;
  nearby_docs: string[];
}

function existsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function existsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function rel(root: string, target: string): string {
  return toPosix(path.relative(root, target));
}

function findRepoRoot(start: string): string {
  let cur = path.resolve(start);
  while (true) {
    if (
      existsFile(path.join(cur, "core", "manifest.json")) &&
      existsDir(path.join(cur, "packages", "cli"))
    ) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(start);
    cur = parent;
  }
}

function walkMarkdownDocs(repoRoot: string): string[] {
  const docsRoot = path.join(repoRoot, "docs");
  if (!existsDir(docsRoot)) return [];
  const out: string[] = [];
  const stack = [docsRoot];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(rel(repoRoot, abs));
      }
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function scoreDoc(candidate: string, wanted: string): number {
  const wantedTokens = new Set(
    toPosix(wanted)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  return toPosix(candidate)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => wantedTokens.has(token)).length;
}

function nearbyDocs(repoRoot: string, wantedDoc: string | undefined): string[] {
  const docs = walkMarkdownDocs(repoRoot);
  if (!wantedDoc) return docs.slice(0, 12);
  return docs
    .map((doc) => ({ doc, score: scoreDoc(doc, wantedDoc) }))
    .sort((a, b) => b.score - a.score || a.doc.localeCompare(b.doc))
    .slice(0, 12)
    .map((x) => x.doc);
}

function checkFile(repoRoot: string, keyPath: string): CheckResult {
  const abs = path.join(repoRoot, keyPath);
  const ok = existsFile(abs);
  return {
    ok,
    detail: ok ? keyPath : `${keyPath} missing`,
  };
}

function buildReport(args: Args): DoctorReport {
  const projectDir = resolveProjectDir(args.values["project-dir"]);
  const repoRoot = findRepoRoot(projectDir);
  const docArg = args.values.doc;
  const checks: Record<string, CheckResult> = {};

  checks.repo_root = {
    ok:
      existsFile(path.join(repoRoot, "core", "manifest.json")) &&
      existsDir(path.join(repoRoot, "packages", "cli")),
    detail: repoRoot,
  };
  checks.root_shim = checkFile(repoRoot, "bin/e2e-loop");
  checks.package_bin = checkFile(repoRoot, "packages/cli/package.json");
  checks.source_entry = checkFile(repoRoot, "packages/cli/src/index.ts");
  checks.dist_entry = checkFile(repoRoot, "packages/cli/dist/index.js");
  checks.runs_root = {
    ok: true,
    detail: existsDir(path.join(repoRoot, "runs"))
      ? "runs/ exists"
      : "runs/ missing; no run has been initialized in this checkout",
  };
  checks.worktree_marker = {
    ok: true,
    detail: existsFile(path.join(repoRoot, ".loop-engineering", "worktree.json"))
      ? ".loop-engineering/worktree.json exists"
      : "not inside a managed loop worktree marker at repo root",
  };

  if (docArg) {
    const docAbs = path.isAbsolute(docArg) ? docArg : path.join(repoRoot, docArg);
    const ok = existsFile(docAbs);
    checks.document_exists = {
      ok,
      detail: ok ? rel(repoRoot, docAbs) : `${toPosix(docArg)} missing`,
    };
  }

  const ok = Object.values(checks).every((check) => check.ok);
  return {
    ok,
    cwd: process.cwd(),
    repo_root: repoRoot,
    checks,
    nearby_docs: nearbyDocs(repoRoot, docArg),
  };
}

function renderHuman(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`e2e-loop doctor: ${report.ok ? "ok" : "blocked"}`);
  lines.push(`repo_root: ${report.repo_root}`);
  for (const [name, check] of Object.entries(report.checks)) {
    lines.push(`  ${check.ok ? "ok" : "fail"} ${name}: ${check.detail}`);
  }
  if (!report.ok && report.nearby_docs.length > 0) {
    lines.push("nearby_docs:");
    for (const doc of report.nearby_docs) {
      lines.push(`  - ${doc}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function runDoctor(args: Args): Promise<number> {
  const report = buildReport(args);
  if (args.flags.has("json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderHuman(report));
  }
  return report.ok ? 0 : 1;
}
