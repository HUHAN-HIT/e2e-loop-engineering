/**
 * resolveRunsRoot worktree 解析测试。
 *
 * 背景: hook 在 git linked worktree 里运行时, cwd 指向 worktree, 其下没有 runs/
 * (run 状态在主仓)。需要让 resolveRunsRoot 在 worktree 里也能解析回主仓的 runs/。
 *
 * 新优先级 (严格按序, 保证向后兼容):
 *   1. LOOP_RUNS_ROOT 环境变量 (最高优先级, 不变)
 *   2. <repoRoot>/runs 已存在 → 快路径直接返回 (不调 git, 零开销)
 *   3. 否则尝试 git rev-parse --git-common-dir → 解析回主仓根 → mainRoot/runs
 *   4. 任何异常 → 回退 <repoRoot>/runs (当前行为)
 *
 * 隔离策略: 每个用例独立 mkdtemp; 开头 delete LOOP_RUNS_ROOT 避免全局 env 干扰,
 * afterEach 恢复 env + 清理 tmp。
 */

import { test, expect, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findActiveRun, resolveRunsRoot } from "@e2e-loop/shared";

// ---------------------------------------------------------------------------
// 临时夹具工具
// ---------------------------------------------------------------------------

const _toClean: string[] = [];
const _envBackup = process.env.LOOP_RUNS_ROOT;

afterEach(() => {
  if (_envBackup === undefined) delete process.env.LOOP_RUNS_ROOT;
  else process.env.LOOP_RUNS_ROOT = _envBackup;
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
  // realpathSync: macOS/Windows 的 tmpdir 可能含符号链接, git 会返回真实路径,
  // 规范化后断言才稳。
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `e2e-runs-wt-${label}-`)),
  );
  _toClean.push(root);
  return root;
}

/** 在指定 cwd 跑 git 命令 (子进程退出码非 0 会 throw)。 */
function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const RUN_STATE = JSON.stringify({
  run_id: "20260101-001",
  phase: "IMPLEMENTING",
  complexity: "simple",
  trust_mode: "collaborative",
  active_tasks: [],
});

// ---------------------------------------------------------------------------
// 用例 1: 在 linked worktree 里 → 解析回主仓的 runs/
// ---------------------------------------------------------------------------

test("worktree cwd → resolveRunsRoot/findActiveRun 解析回主仓 runs/", () => {
  delete process.env.LOOP_RUNS_ROOT;

  const mainRepo = makeTmp("main");
  // 1) 初始化主仓 + 必要身份配置 + 首个提交 (worktree add 需要至少一个 commit)
  git(mainRepo, ["init", "-b", "main"]);
  git(mainRepo, ["config", "user.email", "test@example.com"]);
  git(mainRepo, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(mainRepo, "README.md"), "init\n", "utf-8");
  git(mainRepo, ["add", "README.md"]);
  git(mainRepo, ["commit", "-m", "init"]);

  // 2) 主仓建 runs/20260101-001/run-state.json
  const runDir = path.join(mainRepo, "runs", "20260101-001");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "run-state.json"), RUN_STATE, "utf-8");

  // 3) 在主仓外的 tmp 建 linked worktree
  const wtParent = makeTmp("wt");
  const wt = path.join(wtParent, "wt");
  git(mainRepo, ["worktree", "add", wt, "-b", "wtbranch"]);

  // worktree 里没有 runs/ (它是主仓的内容, 不在工作树)
  expect(fs.existsSync(path.join(wt, "runs"))).toBe(false);

  // resolveRunsRoot 应解析回主仓的 runs/
  const resolved = resolveRunsRoot(wt);
  expect(resolved).toBe(path.join(mainRepo, "runs"));

  // findActiveRun 应能据此找到那个 active run
  const active = findActiveRun(wt);
  expect(active).not.toBeNull();
  expect(active!.runId).toBe("20260101-001");
});

// ---------------------------------------------------------------------------
// 用例 2: 普通仓库快路径 (runs/ 已存在, 不依赖 git)
// ---------------------------------------------------------------------------

test("普通目录 runs/ 已存在 → 快路径直接返回 (不 init git)", () => {
  delete process.env.LOOP_RUNS_ROOT;

  const dir = makeTmp("fast");
  fs.mkdirSync(path.join(dir, "runs"), { recursive: true });

  // 走快路径 (步骤2): runs/ 存在直接返回, 不调 git
  expect(resolveRunsRoot(dir)).toBe(path.join(dir, "runs"));
});

// ---------------------------------------------------------------------------
// 用例 3: LOOP_RUNS_ROOT 优先 (最高优先级, 绝对路径)
// ---------------------------------------------------------------------------

test("LOOP_RUNS_ROOT 设了绝对路径 → 最高优先级, 直接返回", () => {
  const abs = makeTmp("override");
  process.env.LOOP_RUNS_ROOT = abs;

  // 即使 repoRoot 随便给, 也应返回 override
  expect(resolveRunsRoot("anything")).toBe(abs);
});
