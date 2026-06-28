/**
 * Run 目录扫描与读取 (规范源: design §6)。
 *
 * - findActiveRun: 在 <repoRoot>/runs/ 下扫描所有 run, 返回最新非终态的一个。
 * - readRunState: 读单个 run 的 run-state.json。
 *
 * 与 Python `runtime/directory.py` 行为一致: 默认 runs/ 目录, 可被 LOOP_RUNS_ROOT 环境变量覆盖。
 */

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
 * 解析 runs 根目录: 优先 LOOP_RUNS_ROOT 环境变量, 否则 <repoRoot>/runs。
 *
 * LOOP_RUNS_ROOT 若是相对路径, 相对 repoRoot 解析 (与 Python 端行为一致)。
 */
export function resolveRunsRoot(repoRoot: string): string {
  const override = process.env.LOOP_RUNS_ROOT;
  if (override && override.trim() !== "") {
    return path.isAbsolute(override)
      ? override
      : path.resolve(repoRoot, override);
  }
  return path.join(repoRoot, "runs");
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
