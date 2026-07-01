/**
 * e2e-loop resume 命令 + buildResumeSpawn 纯函数 + init 生成 resume 脚本 测试。
 *
 * 背景 (2026-07-01 新增): worktree bootstrap 后, coordinator 自动跑 `e2e-loop resume <run_id>`
 * 弹一个新终端在该 worktree 内起 claude 会话续跑到 plan 签署 —— 消除"手动 cd 开新会话"这个
 * 能力性人工步骤。resume 用依赖注入的 spawner (测试注入 fake, 不真弹窗); 无终端/spawn 失败
 * → 降级手动引导、退出 0 (fail-safe)。
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import {
  runInit,
  runResume,
  buildResumeSpawn,
} from "../packages/cli/src/commands/dryrun.js";
import { parseCliArgs } from "../packages/cli/src/args.js";
import { initRunDir, writeRunState } from "../packages/ssot-ts/src/runtime/index.js";
import { Phase, parseRunState } from "../packages/ssot-ts/src/schema/run_state.js";

// ---------------------------------------------------------------------------
// 夹具工具 (仿 cli_worktree_gate.test.ts)
// ---------------------------------------------------------------------------

const _toClean: string[] = [];
const _cwdBackup = process.cwd();

afterEach(() => {
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-resume-${label}-`));
  _toClean.push(d);
  return d;
}

function makeReqFile(dir: string): string {
  const p = path.join(dir, "req.md");
  fs.writeFileSync(p, "# 测试需求\n做点啥\n", "utf-8");
  return p;
}

/** 在 dir 初始化一个带 1 个初始 commit 的真实 git 仓库 (.worktrees/ 已 ignore)。 */
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

/** 建一个 run (workdir 非空 → worktree 模式; null → none 模式)。resume 不检查 phase。 */
function makeRun(
  runsRoot: string,
  runId: string,
  opts: { workdir?: string | null },
): void {
  const runDir = initRunDir(runsRoot, runId, "test requirement");
  const st: Record<string, unknown> = {
    run_id: runId,
    complexity: "simple",
    phase: Phase.PLANNING,
  };
  if (opts.workdir) st.workdir = opts.workdir;
  writeRunState(runDir, parseRunState(st));
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

// ---------------------------------------------------------------------------
// buildResumeSpawn 纯函数: 各平台弹终端命令
// ---------------------------------------------------------------------------

test("buildResumeSpawn win32: start cmd /k 起 claude /loop-engineering, 含 workdir", () => {
  const spec = buildResumeSpawn("win32", "C:\\repo\\.worktrees\\20260101-001");
  expect(spec).not.toBeNull();
  expect(spec!.cmd).toBe("cmd.exe");
  const joined = spec!.args.join(" ");
  expect(joined).toContain("start");
  expect(joined).toContain("claude");
  expect(joined).toContain("/loop-engineering");
  expect(spec!.args.some((a) => a.includes("20260101-001"))).toBe(true);
});

test("buildResumeSpawn darwin: osascript 起 Terminal", () => {
  const spec = buildResumeSpawn("darwin", "/tmp/wt");
  expect(spec).not.toBeNull();
  expect(spec!.cmd).toBe("osascript");
  expect(spec!.args.join(" ")).toContain("claude");
  expect(spec!.args.join(" ")).toContain("/tmp/wt");
});

test("buildResumeSpawn linux: x-terminal-emulator best-effort", () => {
  const spec = buildResumeSpawn("linux", "/tmp/wt");
  expect(spec).not.toBeNull();
  expect(spec!.cmd).toBe("x-terminal-emulator");
  expect(spec!.args.join(" ")).toContain("claude");
});

test("buildResumeSpawn 未知平台 → null (调用方降级)", () => {
  expect(buildResumeSpawn("sunos" as NodeJS.Platform, "/tmp/wt")).toBeNull();
});

// ---------------------------------------------------------------------------
// runResume: 注入 spawner
// ---------------------------------------------------------------------------

test("runResume: worktree 模式 run → 调 spawner 弹终端, return 0", () => {
  const repo = makeTmp("wt");
  const runsRoot = path.join(repo, "runs");
  makeRun(runsRoot, "20260101-001", { workdir: path.join(repo, ".worktrees", "20260101-001") });

  const calls: { cmd: string; args: readonly string[] }[] = [];
  const args = parseCliArgs(["resume", "20260101-001", "--runs-root", runsRoot]);
  const { result, stdout } = withCapturedStreams(() =>
    runResume(args, (cmd, a) => {
      calls.push({ cmd, args: a });
    }),
  );

  expect(result).toBe(0);
  // 当前测试平台 (win32/darwin/linux) buildResumeSpawn 均非 null → spawner 被调一次
  expect(calls.length).toBe(1);
  expect(stdout).toContain("弹出新终端");
});

test("runResume: none 模式 run (无 workdir) → 不弹终端, 提示就地续跑", () => {
  const repo = makeTmp("none");
  const runsRoot = path.join(repo, "runs");
  makeRun(runsRoot, "20260101-002", { workdir: null });

  const calls: unknown[] = [];
  const args = parseCliArgs(["resume", "20260101-002", "--runs-root", runsRoot]);
  const { result, stdout } = withCapturedStreams(() =>
    runResume(args, () => {
      calls.push(1);
    }),
  );

  expect(result).toBe(0);
  expect(calls.length).toBe(0);
  expect(stdout).toContain("none 模式");
});

test("runResume: spawn 抛错 → 降级手动引导, 退出 0 (fail-safe)", () => {
  const repo = makeTmp("fail");
  const runsRoot = path.join(repo, "runs");
  makeRun(runsRoot, "20260101-003", { workdir: path.join(repo, ".worktrees", "20260101-003") });

  const args = parseCliArgs(["resume", "20260101-003", "--runs-root", runsRoot]);
  const { result, stdout } = withCapturedStreams(() =>
    runResume(args, () => {
      throw new Error("no terminal available");
    }),
  );

  expect(result).toBe(0);
  expect(stdout).toContain("手动");
  expect(stdout).toContain("resume.cmd");
});

test("runResume: run 不存在 → return 2", () => {
  const repo = makeTmp("missing");
  initGitRepo(repo);
  process.chdir(repo);
  const args = parseCliArgs(["resume", "nope", "--runs-root", path.join(repo, "runs")]);
  const { result, stderr } = withCapturedStreams(() => runResume(args, () => {}));

  expect(result).toBe(2);
  expect(stderr).toContain("找不到 run");
});

test("runResume: worktree 模式 run 在 .worktrees 下 → 从主根定位到 (回归: 落地 bug 2026-07-01)", () => {
  // resume 从主工程根跑, worktree 模式 run 的 run-state 在 .worktrees/<id>/runs/<id>,
  // 不在主根 runs/ —— 早期 runResume 只查主根导致 "run-state.json 不存在"。
  const repo = makeTmp("wt-locate");
  initGitRepo(repo);
  process.chdir(repo);
  const runId = "20260101-050";
  const wt = path.join(repo, ".worktrees", runId);
  makeRun(path.join(wt, "runs"), runId, { workdir: wt });

  const calls: unknown[] = [];
  const args = parseCliArgs(["resume", runId]); // 不传 --runs-root, 从主根定位
  const { result, stdout } = withCapturedStreams(() =>
    runResume(args, () => {
      calls.push(1);
    }),
  );

  expect(result).toBe(0);
  expect(calls.length).toBe(1);
  expect(stdout).toContain("弹出新终端");
});

// ---------------------------------------------------------------------------
// init 生成 resume 脚本 (改动③)
// ---------------------------------------------------------------------------

test("runInit worktree 模式: worktree 根生成 resume.cmd / resume.sh", () => {
  const repo = makeTmp("init-scripts");
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

  expect(result).toBe(0);
  const m = stdout.match(/workdir:\s*(.+)/);
  expect(m).not.toBeNull();
  const workdir = m![1]!.trim();

  expect(fs.existsSync(path.join(workdir, "resume.cmd"))).toBe(true);
  expect(fs.existsSync(path.join(workdir, "resume.sh"))).toBe(true);
  const cmd = fs.readFileSync(path.join(workdir, "resume.cmd"), "utf-8");
  expect(cmd).toContain("claude");
  expect(cmd).toContain("/loop-engineering");
});
