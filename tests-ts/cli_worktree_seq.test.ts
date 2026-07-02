/**
 * allWorktreeRunsRoots: run_id 序号跨 worktree 防撞的序号源收集。
 *
 * 背景(EnterWorktree 化 2026-07-01): 每个 run 落各自 worktree 的 runs/; none 模式序号须纳入
 * 所有 worktree 的 runs/ 才不跨 worktree 撞号。本测验证用 git worktree list 解析出主仓 + 所有
 * linked worktree 的 runs 路径, 且非 git 目录降级为空(不回归现有 none 行为)。
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { allWorktreeRunsRoots } from "../packages/cli/src/commands/dryrun.js";

const _toClean: string[] = [];
afterEach(() => {
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
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `loop-seq-${label}-`)));
  _toClean.push(d);
  return d;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

test("allWorktreeRunsRoots: 列出主仓 + 所有 linked worktree 的 runs/", () => {
  const main = makeTmp("main");
  git(main, ["init", "-q", "-b", "main"]);
  git(main, ["config", "user.email", "t@e.com"]);
  git(main, ["config", "user.name", "t"]);
  git(main, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(main, "README.md"), "x\n");
  git(main, ["add", "-A"]);
  git(main, ["commit", "-q", "-m", "init"]);

  const wtParent = makeTmp("wt");
  const wt1 = path.join(wtParent, "wt1");
  git(main, ["worktree", "add", "-q", wt1, "-b", "b1"]);

  const roots = allWorktreeRunsRoots(main);
  // 主仓 + wt1 两个 worktree 的 runs/ 都在
  expect(roots.length).toBeGreaterThanOrEqual(2);
  expect(roots.every((r) => r.endsWith("runs"))).toBe(true);
  expect(roots.some((r) => r.toLowerCase().includes("wt1"))).toBe(true);
});

test("allWorktreeRunsRoots: 非 git 目录 → 返回 [] (降级不回归)", () => {
  const dir = makeTmp("nogit");
  expect(allWorktreeRunsRoots(dir)).toEqual([]);
});
