/**
 * e2e-loop runs (并行 run 总览) 测试。
 *
 * 背景 (2026-07-01 新增): 并行开发多 run 时, 每个 run 一个隔离 worktree、一个会话。
 * `e2e-loop runs` 在主工程根扫主根 runs/ (none 模式) 与各 worktree 下的 runs/ (worktree 模式),
 * 一眼看全各支线的 phase / human_pending / workdir —— 补上多支线全局调度视角。
 *
 * runRuns 用 resolveWorktreeRoot(process.cwd()) 解析 .worktrees, 内部调 git → 测试须在真 git 仓内跑。
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { runRuns } from "../packages/cli/src/commands/dryrun.js";
import { parseCliArgs } from "../packages/cli/src/args.js";
import { initRunDir, writeRunState } from "../packages/ssot-ts/src/runtime/index.js";
import { Phase, parseRunState } from "../packages/ssot-ts/src/schema/run_state.js";

// ---------------------------------------------------------------------------
// 夹具工具
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-runs-ov-${label}-`));
  _toClean.push(d);
  return d;
}

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

function makeRun(
  runsRoot: string,
  runId: string,
  opts: { workdir?: string | null; phase?: string },
): void {
  const runDir = initRunDir(runsRoot, runId, "test requirement");
  const st: Record<string, unknown> = {
    run_id: runId,
    complexity: "simple",
    phase: opts.phase ?? Phase.PLANNING,
  };
  if (opts.workdir) st.workdir = opts.workdir;
  writeRunState(runDir, parseRunState(st));
}

function withCapturedStreams<T>(fn: () => T): { result: T; stdout: string; stderr: string } {
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
// 用例
// ---------------------------------------------------------------------------

test("runs: 总览主根 none run + worktree run", () => {
  const repo = makeTmp("mix");
  initGitRepo(repo);
  process.chdir(repo);

  // 主根 none 模式 run
  makeRun(path.join(repo, "runs"), "20260101-001", { workdir: null, phase: Phase.PLANNING });
  // 真 git worktree(runRuns 经 git worktree list 发现; 手建目录不会被列出)
  const wtParent = makeTmp("wt");
  const wt = path.join(wtParent, "wt-b");
  execFileSync("git", ["worktree", "add", "-q", wt, "-b", "b-mix"], {
    cwd: repo,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  makeRun(path.join(wt, "runs"), "20260101-002", { workdir: wt, phase: Phase.IMPLEMENTING });

  const args = parseCliArgs(["runs", "--runs-root", path.join(repo, "runs")]);
  const { result, stdout } = withCapturedStreams(() => runRuns(args));

  expect(result).toBe(0);
  expect(stdout).toContain("20260101-001");
  expect(stdout).toContain("20260101-002");
  expect(stdout).toContain("PLANNING");
  expect(stdout).toContain("IMPLEMENTING");
});

test("runs --json: 机器可读, runs 数组含各 run", () => {
  const repo = makeTmp("json");
  initGitRepo(repo);
  process.chdir(repo);
  makeRun(path.join(repo, "runs"), "20260101-010", { workdir: null });

  const args = parseCliArgs(["runs", "--runs-root", path.join(repo, "runs"), "--json"]);
  const { result, stdout } = withCapturedStreams(() => runRuns(args));

  expect(result).toBe(0);
  const parsed = JSON.parse(stdout) as { runs: { run_id: string }[] };
  expect(Array.isArray(parsed.runs)).toBe(true);
  expect(parsed.runs.some((r) => r.run_id === "20260101-010")).toBe(true);
});

test("runs: 无任何 run → 提示没有 run", () => {
  const repo = makeTmp("empty");
  initGitRepo(repo);
  process.chdir(repo);

  const args = parseCliArgs(["runs", "--runs-root", path.join(repo, "runs")]);
  const { result, stdout } = withCapturedStreams(() => runRuns(args));

  expect(result).toBe(0);
  expect(stdout).toContain("没有 run");
});
