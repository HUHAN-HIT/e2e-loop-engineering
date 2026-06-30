/**
 * CLI worktree enforcement gate 测试 (spec: 2026-06-29-worktree-only-isolation-design 改动②/③)。
 *
 * 覆盖 spec 测试点 5/6/7/8:
 *   - runInit: cwd 已是 loop worktree (有 marker) → 拒绝再 init (return 2, 信息含 "一个 worktree")。
 *   - runInit: worktree 模式 (--worktree-mode always) → stdout 含进 worktree 引导。
 *   - runDispatch/runRun:
 *       ① none 模式 run + 任意 cwd → 放行 (回归保护)。
 *       ② worktree 模式 run + cwd 非该 worktree → 拒绝 (return 2)。
 *       ③ worktree 模式 run + cwd 在该 worktree (marker.run_id 匹配) → 放行。
 *
 * 这些命令函数读 process.cwd() 做 worktree 判据, 测试用 process.chdir 控制 cwd;
 * stdout/stderr 用 spy 捕获 (不跨进程, 直接调命令函数, 与现有 dry-run 路径风格一致,
 * 但比 integration_dry_run 的 execFileSync 更轻、可精准断言退出码)。
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import {
  runInit,
  runDispatch,
  runRun,
} from "../packages/cli/src/commands/dryrun.js";
import { parseCliArgs } from "../packages/cli/src/args.js";
import {
  WORKTREE_MARKER_REL,
  WORKTREE_MARKER_SCHEMA,
  WORKTREE_MARKER_OWNER,
} from "../packages/shared/src/worktree_marker.js";
import {
  initRunDir,
  writeRunState,
  readTaskPlan,
  writeTaskPlan,
} from "../packages/ssot-ts/src/runtime/index.js";
import {
  Phase,
  parseRunState,
} from "../packages/ssot-ts/src/schema/run_state.js";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SMOKE_PLAN = path.join(TESTS_DIR, "fixtures", "smoke", "task-plan.yaml");

// ---------------------------------------------------------------------------
// 夹具工具
// ---------------------------------------------------------------------------

const _toClean: string[] = [];
const _cwdBackup = process.cwd();

afterEach(() => {
  // 恢复 cwd, 防止用例间串台
  try {
    process.chdir(_cwdBackup);
  } catch {
    /* 忽略 */
  }
  while (_toClean.length) {
    const d = _toClean.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响断言 */
    }
  }
});

function makeTmp(label: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-cli-gate-${label}-`));
  _toClean.push(d);
  return d;
}

/** 在 root 写一个合法 worktree 根 marker (绑定 runId)。 */
function writeMarker(root: string, runId: string): void {
  const markerPath = path.join(root, WORKTREE_MARKER_REL);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(
    markerPath,
    JSON.stringify({
      schema: WORKTREE_MARKER_SCHEMA,
      owner: WORKTREE_MARKER_OWNER,
      run_id: runId,
      created_at: "2026-06-29T00:00:00.000Z",
    }),
    "utf-8",
  );
}

/**
 * 建一个处于 IMPLEMENTING 的 run (dispatch/run gate 命令要求 IMPLEMENTING)。
 * workdir 非空 → worktree 模式; workdir=null → none 模式。
 *
 * 同时落一份 planning/task-plan.yaml (smoke 1-task plan), 让 gate 放行后命令体
 * (dispatchReadyTasks / runUntilHumanOrTerminal) 不因 plan 为空而抛 —— 这样
 * "放行" 用例能真正断言 return 0。
 */
function makeImplementingRun(
  runsRoot: string,
  runId: string,
  opts: { workdir?: string | null },
): string {
  const runDir = initRunDir(runsRoot, runId, "test requirement");
  const stateInput: Record<string, unknown> = {
    run_id: runId,
    complexity: "simple",
    phase: Phase.IMPLEMENTING,
    // 关掉 capabilities 探测的 fs_snapshot 噪音 (与 integration_dispatch_collect 一致)
    capabilities: { git_diff: false, fs_snapshot: false },
  };
  if (opts.workdir) {
    stateInput.workdir = opts.workdir;
  }
  writeRunState(runDir, parseRunState(stateInput));
  // 落 task-plan (经 readTaskPlan → writeTaskPlan 走 zod parse + dump, 补默认字段)
  const plan = readTaskPlan(SMOKE_PLAN);
  writeTaskPlan(path.join(runDir, "planning", "task-plan.yaml"), plan);
  return runDir;
}

/** 捕获 stdout/stderr 的简单 spy。 */
function withCapturedStreams<T>(fn: () => T): {
  result: T;
  stdout: string;
  stderr: string;
} {
  let stdout = "";
  let stderr = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout.write as unknown) = (chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    return true;
  };
  (process.stderr.write as unknown) = (chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    return true;
  };
  try {
    const result = fn();
    return { result, stdout, stderr };
  } finally {
    (process.stdout.write as unknown) = origOut;
    (process.stderr.write as unknown) = origErr;
  }
}

/** 写一个 requirement.md 临时文件, 返回路径。 */
function makeReqFile(dir: string): string {
  const p = path.join(dir, "req.md");
  fs.writeFileSync(p, "# 测试需求\n做点啥\n", "utf-8");
  return p;
}

/** 在 dir 初始化一个带 1 个初始 commit 的真实 git 仓库 (allocator always 调真实 git)。 */
function initGitRepo(dir: string): void {
  const g = (...a: string[]) =>
    execFileSync("git", a, { cwd: dir, encoding: "utf-8", stdio: "pipe" });
  g("init", "-q");
  g("config", "user.email", "test@example.com");
  g("config", "user.name", "test");
  g("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".worktrees/\n", "utf-8");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
}

// ---------------------------------------------------------------------------
// 测试点 8: runInit cwd 已是 loop worktree → 拒绝再 init
// ---------------------------------------------------------------------------

test("[改动③] runInit: cwd 已是 loop worktree (有 marker) → 拒绝 (return 2, 信息含 一个 worktree)", () => {
  const repo = makeTmp("init-in-wt");
  writeMarker(repo, "20260629-001"); // cwd 已绑定一个 run
  const reqPath = makeReqFile(repo);
  process.chdir(repo);

  const args = parseCliArgs([
    "init",
    reqPath,
    "--worktree-mode",
    "always",
    "--runs-root",
    path.join(repo, "runs"),
  ]);
  const { result, stderr } = withCapturedStreams(() => runInit(args));

  expect(result).toBe(2);
  expect(stderr).toContain("一个 worktree");
});

// ---------------------------------------------------------------------------
// 测试点 7: runInit worktree 模式 → stdout 含进 worktree 引导
// ---------------------------------------------------------------------------

test("[改动②] runInit: worktree 模式 (always) → stdout 含进 worktree 引导 (cd <workdir>)", () => {
  const repo = makeTmp("init-bootstrap");
  // 真实 git 仓 (allocator always 会 git worktree add); .gitignore 含 .worktrees/
  initGitRepo(repo);
  const reqPath = makeReqFile(repo);
  process.chdir(repo);

  const args = parseCliArgs([
    "init",
    reqPath,
    "--worktree-mode",
    "always",
    "--runs-root",
    path.join(repo, "runs"),
  ]);
  const { result, stdout } = withCapturedStreams(() => runInit(args));

  // allocator always 在非真实 git 仓里会因 git worktree add 失败而抛 (allocator 内调真实 git)。
  // 若 allocation 成功 (binding!=null) → 应有引导; 若失败则跳过本断言不成立。
  // 这里期望: 命令成功 (0) 且引导存在。
  expect(result).toBe(0);
  // 引导文本: 提示 cd 进 worktree 再开会话
  expect(stdout).toContain("cd ");
  expect(stdout.toLowerCase()).toContain("worktree");
});

// ---------------------------------------------------------------------------
// 测试点 5/6: runDispatch gate
// ---------------------------------------------------------------------------

test("[改动②][回归] runDispatch: none 模式 run + 任意 cwd → 放行 (不被 gate)", () => {
  const repo = makeTmp("disp-none");
  const runsRoot = path.join(repo, "runs");
  makeImplementingRun(runsRoot, "20260629-100", { workdir: null });
  // cwd 在一个无 marker 的随机目录
  const elsewhere = makeTmp("disp-none-cwd");
  process.chdir(elsewhere);

  const args = parseCliArgs(["dispatch", "20260629-100", "--runs-root", runsRoot]);
  const { result, stderr } = withCapturedStreams(() => runDispatch(args));

  // none 模式不 gate → 命令正常执行 (return 0); 不应出现 worktree 拒绝信息
  expect(result).toBe(0);
  expect(stderr).not.toContain("worktree 模式");
});

test("[改动②] runDispatch: worktree 模式 run + cwd 非该 worktree → 拒绝 (return 2)", () => {
  const repo = makeTmp("disp-wt-wrongcwd");
  const runsRoot = path.join(repo, "runs");
  const workdir = path.join(repo, ".worktrees", "20260629-101");
  makeImplementingRun(runsRoot, "20260629-101", { workdir });
  // cwd 在一个无 marker 的随机目录 (不是 workdir)
  const elsewhere = makeTmp("disp-wt-elsewhere");
  process.chdir(elsewhere);

  const args = parseCliArgs(["dispatch", "20260629-101", "--runs-root", runsRoot]);
  const { result, stderr } = withCapturedStreams(() => runDispatch(args));

  expect(result).toBe(2);
  expect(stderr).toContain("worktree 模式");
});

test("[改动②] runDispatch: worktree 模式 run + cwd 在该 worktree (marker.run_id 匹配) → 放行", () => {
  const repo = makeTmp("disp-wt-rightcwd");
  // worktree 根目录: 既是 cwd, 又写了匹配 marker; runs/ 放在 worktree 内
  const workdir = makeTmp("disp-wt-workdir");
  const runsRoot = path.join(workdir, "runs");
  makeImplementingRun(runsRoot, "20260629-102", { workdir });
  writeMarker(workdir, "20260629-102");
  process.chdir(workdir);

  const args = parseCliArgs(["dispatch", "20260629-102", "--runs-root", runsRoot]);
  const { result, stderr } = withCapturedStreams(() => runDispatch(args));

  expect(result).toBe(0);
  expect(stderr).not.toContain("worktree 模式");
});

// ---------------------------------------------------------------------------
// runRun gate (与 dispatch 同判据)
// ---------------------------------------------------------------------------

test("[改动②][回归] runRun: none 模式 run + 任意 cwd → 放行", () => {
  const repo = makeTmp("run-none");
  const runsRoot = path.join(repo, "runs");
  makeImplementingRun(runsRoot, "20260629-200", { workdir: null });
  const elsewhere = makeTmp("run-none-cwd");
  process.chdir(elsewhere);

  const args = parseCliArgs(["run", "20260629-200", "--runs-root", runsRoot, "--max-ticks", "1"]);
  const { result, stderr } = withCapturedStreams(() => runRun(args));

  expect(result).toBe(0);
  expect(stderr).not.toContain("worktree 模式");
});

test("[改动②] runRun: worktree 模式 run + cwd 非该 worktree → 拒绝 (return 2)", () => {
  const repo = makeTmp("run-wt-wrongcwd");
  const runsRoot = path.join(repo, "runs");
  const workdir = path.join(repo, ".worktrees", "20260629-201");
  makeImplementingRun(runsRoot, "20260629-201", { workdir });
  const elsewhere = makeTmp("run-wt-elsewhere");
  process.chdir(elsewhere);

  const args = parseCliArgs(["run", "20260629-201", "--runs-root", runsRoot, "--max-ticks", "1"]);
  const { result, stderr } = withCapturedStreams(() => runRun(args));

  expect(result).toBe(2);
  expect(stderr).toContain("worktree 模式");
});

test("[改动②] runRun: worktree 模式 run + cwd 在该 worktree → 放行", () => {
  const workdir = makeTmp("run-wt-workdir");
  const runsRoot = path.join(workdir, "runs");
  makeImplementingRun(runsRoot, "20260629-202", { workdir });
  writeMarker(workdir, "20260629-202");
  process.chdir(workdir);

  const args = parseCliArgs(["run", "20260629-202", "--runs-root", runsRoot, "--max-ticks", "1"]);
  const { result, stderr } = withCapturedStreams(() => runRun(args));

  expect(result).toBe(0);
  expect(stderr).not.toContain("worktree 模式");
});
