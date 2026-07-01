/**
 * e2e-loop doctor 子命令。
 *
 * 目标是把"入口在哪、文档在不在、能不能 init"这类启动前问题变成
 * 机械 preflight, 避免按旧形态误判当前环境。
 *
 * 双态设计 (2026-07-01): doctor 会先判定当前目录是哪一类, 再跑对应判据——
 *   1. 实现仓库态 (impl-repo): 含 core/manifest.json + packages/cli/。
 *      核对源码仓库的 CLI 入口与构建产物 (root_shim / dist_entry ...)。
 *   2. 目标项目态 (target-project): 非源码仓库, 但装了 .claude/skills/loop-engineering/SKILL.md。
 *      源码仓库的构建产物本就不该在这里, 改为核对 skill/agents/hooks 装齐,
 *      且 hook 命令走 CLI 形式 (e2e-loop hook <name>, 规避 .mjs 路径依赖——
 *      .mjs 是 build 产物, 不随 commit 进库, 在新 checkout / git worktree 里会
 *      MODULE_NOT_FOUND 崩溃)。
 *   3. 未知态 (unknown): 两者皆非。直接 blocked, 提示先 install 或 cd 到正确目录。
 *
 * 旧实现只有实现仓库态一条路径, 在目标项目里跑会把源码仓库产物全判 fail (假阴性)。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Args } from "../args.js";
import { resolveProjectDir } from "../util.js";

interface CheckResult {
  ok: boolean;
  detail: string;
}

type DoctorMode = "impl-repo" | "target-project" | "unknown";

interface DoctorReport {
  ok: boolean;
  mode: DoctorMode;
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

function checkFile(root: string, keyPath: string): CheckResult {
  const abs = path.join(root, keyPath);
  const ok = existsFile(abs);
  return {
    ok,
    detail: ok ? keyPath : `${keyPath} missing`,
  };
}

function checkDocArg(root: string, docArg: string): CheckResult {
  const docAbs = path.isAbsolute(docArg) ? docArg : path.join(root, docArg);
  const ok = existsFile(docAbs);
  return { ok, detail: ok ? rel(root, docAbs) : `${toPosix(docArg)} missing` };
}

// ---------------------------------------------------------------------------
// 目标项目态判据
// ---------------------------------------------------------------------------

/** install 落到 .claude/agents/ 的 4 个 subagent 文件名 (core/subagents/*.md)。 */
const AGENT_FILES = [
  "clarification-finder.md",
  "implementation-worker.md",
  "plan-agent.md",
  "red-team-reviewer.md",
] as const;

/** hook 事件 → 期望挂载的 loop hook (dash 形式子命令名)。 */
const HOOK_EVENTS: ReadonlyArray<{ event: string; dash: string }> = [
  { event: "SessionStart", dash: "probe-and-gate" },
  { event: "PreToolUse", dash: "guard-paths" },
  { event: "PostToolUse", dash: "post-task-collect" },
  { event: "Stop", dash: "guard-anchors" },
];

const LOOP_HOOK_NAME_RE =
  /\bhook\s+(probe-and-gate|probe_and_gate|guard-paths|guard_paths|post-task-collect|post_task_collect|guard-anchors|guard_anchors)\b/;
const LOOP_HOOK_CLI_NAME_RE =
  /\bhook\s+(probe-and-gate|guard-paths|post-task-collect|guard-anchors)\b/;

/** 该命令是否是本工具的 hook (CLI 形式 或 .mjs 路径形式都算)。 */
function isLoopHookCommand(command: string): boolean {
  const n = command.replaceAll("\\", "/");
  if (n.includes(".claude/hooks/loop_engineering/")) return true;
  return LOOP_HOOK_NAME_RE.test(n);
}

/** 该命令是否是 CLI 形式 (e2e-loop hook <name>, 无 .mjs 路径依赖)。 */
function isCliFormHookCommand(command: string): boolean {
  const n = command.replaceAll("\\", "/");
  if (n.includes(".claude/hooks/")) return false; // 路径形式
  return LOOP_HOOK_CLI_NAME_RE.test(n);
}

/** 从 settings.hooks[event] 收集所有 command 字符串 (按事件分组)。 */
function collectHookCommands(settings: unknown): Record<string, string[]> {
  const perEvent: Record<string, string[]> = {};
  for (const { event } of HOOK_EVENTS) perEvent[event] = [];
  if (
    typeof settings !== "object" ||
    settings === null ||
    typeof (settings as Record<string, unknown>).hooks !== "object" ||
    (settings as Record<string, unknown>).hooks === null
  ) {
    return perEvent;
  }
  const hooks = (settings as Record<string, unknown>).hooks as Record<string, unknown>;
  for (const { event } of HOOK_EVENTS) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const g of groups as Array<Record<string, unknown>>) {
      const hs = g?.hooks;
      if (!Array.isArray(hs)) continue;
      for (const h of hs as Array<Record<string, unknown>>) {
        if (typeof h?.command === "string") perEvent[event].push(h.command);
      }
    }
  }
  return perEvent;
}

/**
 * 判定 hook 命令前缀 (如 e2e-loop) 的可达性。纯静态 (不 spawn):
 * doctor 本身正由用户输入的 `e2e-loop doctor` 拉起, 说明该命令名已在 PATH 可达;
 * 只要 settings 里的 hook 前缀是【裸命令名】(无路径分隔符), 它就靠同一 PATH 解析,
 * 可达性隐含成立。前缀带路径分隔符 (绝对/相对路径) 则只提示用户自行确认该路径存在。
 * 软信号: 始终 ok=true, 不阻断 (与 probe_and_gate hook "异常退化放行" 哲学一致——
 * doctor 是 preflight 提示, 不是硬门禁; 确定性失败交给 hooks_wired / hooks_cli_form)。
 *
 * 不 spawn 探测的两点理由: (1) Windows 上 spawnSync 不解析 .cmd shim, 裸 spawn 必 ENOENT
 * 假阴性; (2) prefix 从 .claude/settings.json 解析而来, 属"观察到的数据", 用 shell 执行有注入面。
 */
function probeCliReachable(perEvent: Record<string, string[]>): CheckResult {
  let prefix = "";
  outer: for (const cmds of Object.values(perEvent)) {
    for (const cmd of cmds) {
      const n = cmd.replaceAll("\\", "/");
      if (n.includes(".claude/hooks/")) continue; // 路径形式, 前缀是 node, 不代表 e2e-loop 可达
      const m = n.match(/^(\S+)\s+hook\s+/);
      if (m) {
        prefix = m[1];
        break outer;
      }
    }
  }
  if (!prefix) {
    return { ok: true, detail: "无 CLI 形式 hook 命令, 跳过可达性判定" };
  }
  if (/[\\/]/.test(prefix)) {
    return {
      ok: true,
      detail: `hook 前缀 '${prefix}' 是路径形式, 请确认该路径存在且可执行 (软信号, 不阻断)`,
    };
  }
  return {
    ok: true,
    detail: `hook 前缀 '${prefix}' 为裸命令名, 靠 PATH 解析 (doctor 正由同名 CLI 拉起, 可达性隐含成立)`,
  };
}

function buildTargetProjectChecks(projectDir: string): Record<string, CheckResult> {
  const checks: Record<string, CheckResult> = {};

  // 1. skill
  checks.skill_installed = checkFile(
    projectDir,
    ".claude/skills/loop-engineering/SKILL.md",
  );

  // 2. agents (4 个 subagent)
  const missingAgents = AGENT_FILES.filter(
    (a) => !existsFile(path.join(projectDir, ".claude", "agents", a)),
  );
  checks.agents_installed = {
    ok: missingAgents.length === 0,
    detail:
      missingAgents.length === 0
        ? `${AGENT_FILES.length} subagents present`
        : `missing: ${missingAgents.join(", ")}`,
  };

  // 3. settings.json 解析 + hook 收集
  const settingsPath = path.join(projectDir, ".claude", "settings.json");
  let settings: unknown;
  let parseErr = "";
  if (!existsFile(settingsPath)) {
    parseErr = ".claude/settings.json missing";
  } else {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    } catch (e) {
      parseErr = `settings.json 解析失败: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  const perEvent = collectHookCommands(settings);

  // 4. hooks_wired: 4 个事件都挂了本工具 hook
  if (parseErr) {
    checks.hooks_wired = { ok: false, detail: parseErr };
  } else {
    const notWired = HOOK_EVENTS.filter(
      ({ event }) => !perEvent[event].some(isLoopHookCommand),
    ).map((e) => e.event);
    checks.hooks_wired = {
      ok: notWired.length === 0,
      detail:
        notWired.length === 0
          ? `${HOOK_EVENTS.length} 事件 hook 已接线`
          : `未接线事件: ${notWired.join(", ")}`,
    };
  }

  // 5. hooks_cli_form: 所有本工具 hook 命令都是 CLI 形式 (无 .mjs 路径依赖)
  const pathFormCmds: string[] = [];
  for (const { event } of HOOK_EVENTS) {
    for (const cmd of perEvent[event]) {
      if (isLoopHookCommand(cmd) && !isCliFormHookCommand(cmd)) pathFormCmds.push(cmd);
    }
  }
  checks.hooks_cli_form = {
    ok: checks.hooks_wired.ok && pathFormCmds.length === 0,
    detail: !checks.hooks_wired.ok
      ? "hooks 未接线, 无法判定命令形式"
      : pathFormCmds.length === 0
        ? "hook 命令均为 CLI 形式 (e2e-loop hook <name>, 无 .mjs 路径依赖)"
        : `路径形式 hook (worktree 里会 MODULE_NOT_FOUND, 请改用 CLI 形式): ${pathFormCmds.join("; ")}`,
  };

  // 6. cli_reachable: 软信号
  checks.cli_reachable = probeCliReachable(perEvent);

  return checks;
}

// ---------------------------------------------------------------------------
// 三态 report builder
// ---------------------------------------------------------------------------

function buildImplRepoReport(repoRoot: string, docArg: string | undefined): DoctorReport {
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
  if (docArg) checks.document_exists = checkDocArg(repoRoot, docArg);

  const ok = Object.values(checks).every((c) => c.ok);
  return {
    ok,
    mode: "impl-repo",
    cwd: process.cwd(),
    repo_root: repoRoot,
    checks,
    nearby_docs: ok ? [] : nearbyDocs(repoRoot, docArg),
  };
}

function buildTargetProjectReport(
  projectDir: string,
  docArg: string | undefined,
): DoctorReport {
  const checks = buildTargetProjectChecks(projectDir);
  if (docArg) checks.document_exists = checkDocArg(projectDir, docArg);

  const ok = Object.values(checks).every((c) => c.ok);
  return {
    ok,
    mode: "target-project",
    cwd: process.cwd(),
    repo_root: projectDir,
    checks,
    nearby_docs: ok ? [] : nearbyDocs(projectDir, docArg),
  };
}

function buildUnknownReport(projectDir: string): DoctorReport {
  const checks: Record<string, CheckResult> = {
    mode: {
      ok: false,
      detail:
        "既不是 loop-engineering 源码仓库 (缺 core/manifest.json + packages/cli/), " +
        "也未安装 .claude 资产 (缺 .claude/skills/loop-engineering/SKILL.md); " +
        "请先 `e2e-loop install --host cc --project-dir <此目录>`, 或 cd 到正确目录后重试",
    },
  };
  return {
    ok: false,
    mode: "unknown",
    cwd: process.cwd(),
    repo_root: projectDir,
    checks,
    nearby_docs: nearbyDocs(projectDir, undefined),
  };
}

function buildReport(args: Args): DoctorReport {
  const projectDir = resolveProjectDir(args.values["project-dir"]);
  const repoRoot = findRepoRoot(projectDir);
  const docArg = args.values.doc;

  const isImplRepo =
    existsFile(path.join(repoRoot, "core", "manifest.json")) &&
    existsDir(path.join(repoRoot, "packages", "cli"));
  if (isImplRepo) return buildImplRepoReport(repoRoot, docArg);

  const skillInstalled = existsFile(
    path.join(projectDir, ".claude", "skills", "loop-engineering", "SKILL.md"),
  );
  if (skillInstalled) return buildTargetProjectReport(projectDir, docArg);

  return buildUnknownReport(projectDir);
}

function renderHuman(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`e2e-loop doctor: ${report.ok ? "ok" : "blocked"}`);
  lines.push(`mode: ${report.mode}`);
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
