/**
 * Run 目录扫描与读取 (规范源: design §6)。
 *
 * - findActiveRun: 在 <repoRoot>/runs/ 下扫描所有 run, 返回最新非终态的一个。
 * - readRunState: 读单个 run 的 run-state.json。
 *
 * 与 Python `runtime/directory.py` 行为一致: 默认 runs/ 目录, 可被 LOOP_RUNS_ROOT 环境变量覆盖。
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  isRunState,
  TERMINAL_PHASES,
  type Phase,
  type RunState,
} from "./run_state.js";

/** findActiveRun 返回结构 */
export interface ActiveRun {
  /** run 目录绝对路径 */
  runDir: string;
  runId: string;
}

/**
 * 解析 runs 根目录, 按以下优先级 (严格按序, 保证向后兼容):
 *
 *   1. LOOP_RUNS_ROOT 环境变量 (最高优先级, 大量测试依赖)。
 *      若是相对路径, 相对 repoRoot 解析 (与 Python 端行为一致)。
 *   2. <repoRoot>/runs 已存在 → 直接返回 (快路径: 正常仓库根命中,
 *      不调 git, 零开销零失败面)。
 *   3. 否则 (runs/ 不存在, 典型为 git linked worktree 的 cwd):
 *      尝试 git rev-parse --git-common-dir 解析回主 worktree 根, 返回 <主仓>/runs。
 *      —— hook 在 worktree 里运行时 run 状态在主仓, 据此把门挂回主仓的 runs/。
 *   4. 任何异常 (git 不在 / 非 git 目录 / 超时) → 回退 <repoRoot>/runs (当前行为)。
 */
export function resolveRunsRoot(repoRoot: string): string {
  // 步骤 1: 环境变量覆盖 (最高优先级, 不变)
  const override = process.env.LOOP_RUNS_ROOT;
  if (override && override.trim() !== "") {
    return path.isAbsolute(override)
      ? override
      : path.resolve(repoRoot, override);
  }

  const localRuns = path.join(repoRoot, "runs");

  // 步骤 2: 快路径——repoRoot/runs 已存在则直接用, 不触碰 git
  try {
    if (fs.existsSync(localRuns)) return localRuns;
  } catch {
    // existsSync 几乎不抛 (恶劣路径如含 NUL 字节例外), 异常时落到下面的回退
  }

  // 步骤 3: worktree 解析——经 git-common-dir 找回主仓根
  try {
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    // 返回值可能是相对 (".git", 普通仓库) 或绝对 ("<main>/.git", linked worktree)
    const commonGitDir = path.isAbsolute(out)
      ? out
      : path.resolve(repoRoot, out);
    // 主仓根 = .git 的父目录
    const mainRoot = path.dirname(commonGitDir);
    return path.join(mainRoot, "runs");
  } catch {
    // 步骤 4: git 不在 / 非 git 目录 / 超时 → 回退当前行为, 绝不向上抛
    return localRuns;
  }
}

/**
 * 在 runs 根目录下扫描, 返回最新非终态 (非 COMPLETE / ABORTED) 的 run。
 *
 * "最新" 按 run_id 字典序降序 (run_id 格式 YYYYMMDD-NNN, 字典序与时间序一致);
 * 字典序相同时回退到目录 mtime 降序。
 *
 * runs 目录不存在或无 active run 时返回 null。
 */
export function findActiveRun(repoRoot: string): ActiveRun | null {
  const runsRoot = resolveRunsRoot(repoRoot);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runsRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  // 只看目录
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !name.startsWith("."));

  if (dirs.length === 0) return null;

  // 字典序降序 (run_id 形如 YYYYMMDD-NNN, 字典序 = 时间序)
  dirs.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

  for (const runId of dirs) {
    const runDir = path.join(runsRoot, runId);
    const state = readRunState(runDir);
    if (state === null) continue;
    if (!TERMINAL_PHASES.has(state.phase as Phase)) {
      return { runDir, runId };
    }
  }

  return null;
}

/**
 * 读单个 run 的 run-state.json。
 *
 * 路径约定: <runDir>/run-state.json (design §6)。
 * 文件不存在 / JSON 解析失败 / 结构非法时返回 null (不抛错)。
 */
export function readRunState(runDir: string): RunState | null {
  const statePath = path.join(runDir, "run-state.json");
  let text: string;
  try {
    text = fs.readFileSync(statePath, "utf-8");
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRunState(data)) return null;
  return data;
}
