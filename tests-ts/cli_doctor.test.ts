import { beforeAll, expect, test } from "bun:test";
import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function resolveRepoRoot(): string {
  const candidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    process.cwd(),
  ];
  for (const c of candidates) {
    if (
      fs.existsSync(path.join(c, "core", "manifest.json")) &&
      fs.existsSync(path.join(c, "packages", "cli"))
    ) {
      return c;
    }
  }
  throw new Error(`无法定位仓库根: ${candidates.join(", ")}`);
}

const REPO_ROOT = resolveRepoRoot();
const CLI_BUNDLE = path.join(REPO_ROOT, "packages", "cli", "dist", "index.js");

beforeAll(() => {
  execSync("npm run build", { cwd: REPO_ROOT, stdio: "pipe" });
}, 30000);

function runDoctor(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI_BUNDLE, "doctor", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

test("CLI doctor: reports healthy TypeScript entrypoints as JSON", () => {
  const r = runDoctor(["--json"]);
  expect(r.status).toBe(0);
  expect(r.stderr).toBe("");

  const report = JSON.parse(r.stdout) as {
    ok: boolean;
    checks: Record<string, { ok: boolean; detail?: string }>;
  };
  expect(report.ok).toBe(true);
  expect(report.checks.repo_root.ok).toBe(true);
  expect(report.checks.root_shim.ok).toBe(true);
  expect(report.checks.source_entry.ok).toBe(true);
  expect(report.checks.dist_entry.ok).toBe(true);
});

test("CLI doctor: missing design document blocks preflight with nearby docs", () => {
  const r = runDoctor(["--json", "--doc", "docs/2026-06-28-reconcile-center-design.md"]);
  expect(r.status).toBe(1);
  expect(r.stderr).toBe("");

  const report = JSON.parse(r.stdout) as {
    ok: boolean;
    checks: Record<string, { ok: boolean; detail?: string }>;
    nearby_docs: string[];
  };
  expect(report.ok).toBe(false);
  expect(report.checks.document_exists.ok).toBe(false);
  expect(report.checks.document_exists.detail).toContain(
    "docs/2026-06-28-reconcile-center-design.md",
  );
  expect(report.checks.root_shim.ok).toBe(true);
  expect(report.nearby_docs.length).toBeGreaterThan(0);
});
