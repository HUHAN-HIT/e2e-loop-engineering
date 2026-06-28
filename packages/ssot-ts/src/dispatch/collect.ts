/**
 * worker 交回后的产物回收 + actual_writes 采集 + 任务自检串联 (design §3.4)。
 *
 * 行为权威: Python `loop_engineering/dispatch/collect.py` + `scheduling/actual_writes.py`
 * 的内存采集 API。
 * 规范源: design §3.4 (actual_writes 采集时机) + §0.2 (不信 worker 自报 tests_green) +
 * §2.2 (任务自检)。
 *
 * 关键: collectOutcome 在 worker 交回那一刻立即跑, coordinator 侧独立采集 actual_writes
 * (不经 worker 自报), 再喂给 checks 求值与任务自检。不修改 task, 只产出 CollectedTaskResult。
 *
 * 与 Python / shared 的差异处理:
 * - shared 的 actual_writes (computeActualWrites/checkBoundary) 是**文件式**采集 (从 disk 上
 *   的 before/after.snapshot 文件读), 与 tick 的"阻塞派发 + 内存快照"模型不匹配。Python 端
 *   `scheduling/actual_writes.py` 用的是**内存** API (snapshot 作为参数传入), tick 直接持有
 *   before_snapshot dict。故本模块复刻 Python 内存版的 collectActualWrites / takeFsSnapshot /
 *   collectViaFsSnapshot / detectOutOfBounds, git 采集复用 shared 的 tryGitDiff (行为一致),
 *   产出 ActualWritesCollection / OOBDetection 形状 (后者正是 checkTask 消费的 OOBDetection)。
 * - dataclass(frozen=True) → readonly 接口。
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { tryGitDiff } from "@e2e-loop/shared";

import { checkTask } from "../checklists/task_check.js";
import type { OOBDetection, TaskCheckResult } from "../checklists/task_check.js";
import { evalTask } from "../checklists/checks_eval.js";
import type { TaskCheckEvalResult } from "../checklists/checks_eval.js";
import { pathGlobsOverlap } from "../scheduling/path_overlap.js";
import type { RunCapabilities } from "../schema/run_state.js";
import type { TestResults } from "../schema/artifacts.js";
import type { Task } from "../schema/task_plan.js";
import type { WorkerPacket } from "./packet.js";
import type { WorkerOutcome } from "./worker_runner.js";

/** 路径重叠判定注入签名 (= S3.pathGlobsOverlap)。 */
export type PathOverlapFn = (a: readonly string[], b: readonly string[]) => boolean;

/** fs snapshot: {relative_posix_path: mtime_ns}。Python 用 float, TS 用 number (兼容)。 */
export type FsSnapshot = Record<string, number>;

/**
 * 一次 task 完成后的实际写入采集结果 (等价 Python `ActualWritesCollection`)。
 *
 * is_authoritative=true 表示由 coordinator 侧独立采集 (git / fs), 数据不经 worker。
 * is_authoritative=false 表示回退 worker 自报, 第 2 层防线退化为软约束 (§3.4)。
 */
export interface ActualWritesCollection {
  readonly task_id: string;
  /** "git_diff" | "fs_snapshot" | "worker_self_report" */
  readonly source: string;
  readonly writes: string[];
  readonly is_authoritative: boolean;
}

/**
 * 一次 task 完成后的全量回收结果。
 *
 * 含 actual_writes 采集 + 越界检测 + S4 checks 求值 + S7 任务自检, 以及回查用的 packet。
 * task.status 的修改由 coordinator 决定, 本结果只描述事实。
 */
export interface CollectedTaskResult {
  readonly task_id: string;
  readonly outcome: WorkerOutcome;
  readonly actual_writes: ActualWritesCollection;
  readonly oob: OOBDetection;
  readonly eval_result: TaskCheckEvalResult;
  readonly task_check_result: TaskCheckResult;
  readonly packet: WorkerPacket;
}

// fs snapshot 排除的目录 / 后缀 (与 Python `_FS_EXCLUDE_DIRS` / `_FS_EXCLUDE_SUFFIXES` 一致)。
const FS_EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "__pycache__",
  "node_modules",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
]);
const FS_EXCLUDE_SUFFIXES: readonly string[] = [".pyc", ".pyo"];

/** fs snapshot 是否排除该相对 POSIX 路径 (按目录段 / 后缀)。 */
function shouldExcludePath(relPath: string): boolean {
  if (FS_EXCLUDE_SUFFIXES.some((s) => relPath.endsWith(s))) return true;
  for (const seg of relPath.split("/")) {
    if (FS_EXCLUDE_DIRS.has(seg)) return true;
  }
  return false;
}

/**
 * 遍历 workdir, 返回 {relative_posix_path: mtime_ns} (等价 Python `take_fs_snapshot`)。
 *
 * 排除 .git / __pycache__ / node_modules / *.pyc 等噪音目录与后缀。
 * 失败的 stat 跳过 (不抛)。整体异常返回已采集部分。
 */
export function takeFsSnapshot(workdir: string): FsSnapshot {
  const snapshot: FsSnapshot = {};
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(workdir, full).split(path.sep).join("/");
      if (shouldExcludePath(rel)) continue;
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        try {
          // st_mtime_ns 等价: Node stat 的 mtimeMs * 1e6 (取整为纳秒近似)。
          const st = fs.statSync(full);
          snapshot[rel] = Math.round(st.mtimeMs * 1_000_000);
        } catch {
          continue;
        }
      }
    }
  };
  try {
    if (fs.existsSync(workdir) && fs.statSync(workdir).isDirectory()) {
      walk(workdir);
    }
  } catch {
    return snapshot;
  }
  return snapshot;
}

/**
 * 派出前取 git base ref (§3.4 base ref), 供 worker 交回后 git diff 用
 * (等价 Python `take_git_base_ref`)。
 *
 * 优先 `git stash create` (含未提交改动); 失败回退 `git rev-parse HEAD`。
 * 两者都失败返回 null (回退 fs / self_report)。
 */
export function takeGitBaseRef(workdir: string): string | null {
  const cmds: string[][] = [
    ["stash", "create"],
    ["rev-parse", "HEAD"],
  ];
  for (const args of cmds) {
    try {
      const out = execFileSync("git", ["-C", workdir, ...args], {
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const ref = (out || "").trim();
      if (ref) return ref;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 对比两个 {path: mtime_ns} 快照, 返回 mtime 变化或新增/删除的路径
 * (等价 Python `collect_via_fs_snapshot`)。
 *
 * 删除的路径 (before 有 after 无) 也算"被写过", 一并计入 §3.4 "写过"判。
 */
export function collectViaFsSnapshot(
  beforeSnapshot: FsSnapshot,
  afterSnapshot: FsSnapshot,
): string[] {
  const changed: string[] = [];
  const all = new Set([...Object.keys(beforeSnapshot), ...Object.keys(afterSnapshot)]);
  for (const p of all) {
    if (beforeSnapshot[p] !== afterSnapshot[p]) changed.push(p);
  }
  return changed.sort();
}

/**
 * 按 §3.4 三层优先级采集 actual_writes (等价 Python `collect_actual_writes`)。
 *
 * 1. capabilities.git_diff=true 且 baseRef 提供 → git diff (authoritative)。
 * 2. capabilities.fs_snapshot=true 且 before/after snapshot 都提供 → fs 对比 (authoritative)。
 * 3. 否则回退 workerSelfReport (非 authoritative)。
 *
 * 缺输入时优雅降级 (例如 git_diff=true 但 baseRef=null → 走 fs 或 self_report)。
 */
export function collectActualWrites(
  workdir: string,
  taskId: string,
  capabilities: RunCapabilities,
  options?: {
    baseRef?: string | null;
    beforeSnapshot?: FsSnapshot | null;
    afterSnapshot?: FsSnapshot | null;
    workerSelfReport?: string[] | null;
  },
): ActualWritesCollection {
  const baseRef = options?.baseRef ?? null;
  const beforeSnapshot = options?.beforeSnapshot ?? null;
  const afterSnapshot = options?.afterSnapshot ?? null;
  const workerSelfReport = options?.workerSelfReport ?? null;

  if (capabilities.git_diff && baseRef) {
    const writes = tryGitDiff(workdir, baseRef);
    if (writes !== null) {
      return { task_id: taskId, source: "git_diff", writes, is_authoritative: true };
    }
  }

  if (capabilities.fs_snapshot && beforeSnapshot !== null && afterSnapshot !== null) {
    const writes = collectViaFsSnapshot(beforeSnapshot, afterSnapshot);
    return { task_id: taskId, source: "fs_snapshot", writes, is_authoritative: true };
  }

  return {
    task_id: taskId,
    source: "worker_self_report",
    writes: [...(workerSelfReport ?? [])],
    is_authoritative: false,
  };
}

/**
 * 越界判定 (§3.4 两层, 等价 Python `detect_out_of_bounds`)。
 *
 * 1. actual_writes 中有路径不在 task.allowed_write_paths 范围内 → 越界。
 *    用 pathOverlapFn 判单条 path 是否落在 allowed globs 内: 反向用
 *    overlap([path], allowed), false 即越界。
 * 2. actual_writes 中有路径已被更早 task 写过 → 越界 (跨 task 共享路径归最早写入者)。
 *
 * actual_writes 为空 → 不越界 (is_oob=false), 不抛。
 */
export function detectOutOfBounds(
  task: Task,
  collection: ActualWritesCollection,
  options?: {
    pathOverlapFn?: PathOverlapFn;
    earlierTaskWrites?: Record<string, string[]> | null;
  },
): OOBDetection {
  const pathOverlapFn: PathOverlapFn = options?.pathOverlapFn ?? pathGlobsOverlap;
  const earlierTaskWrites = options?.earlierTaskWrites ?? null;

  const declared = [...task.allowed_write_paths];
  const actual = [...collection.writes];
  const oob: string[] = [];

  for (const p of actual) {
    // 层 1: path 不在 declared 范围内 → 越界。
    const inDeclared = declared.length > 0 ? pathOverlapFn([p], declared) : false;
    if (!inDeclared) {
      oob.push(p);
      continue;
    }
    // 层 2: path 已被更早 task 写过 → 越界 (归最早写入者)。
    if (
      earlierTaskWrites &&
      Object.values(earlierTaskWrites).some((writes) => writes.includes(p))
    ) {
      oob.push(p);
    }
  }

  return {
    task_id: task.id,
    declared_paths: declared,
    actual_writes: actual,
    out_of_bounds: oob,
    is_oob: oob.length > 0,
  };
}

/**
 * 串联 §3.4 actual_writes 采集 + §3.1 checks 求值 + §2.2 任务自检
 * (等价 Python `collect_outcome`)。
 *
 * @param task 当前 task (只读, 不修改)。
 * @param outcome worker 交回的 outcome。
 * @param packet 派发时的 packet (含 workdir / allowed_write_paths 等回查)。
 * @param capabilities 宿主能力 (决定 actual_writes 走哪一层采集)。
 * @param options.baseRef git diff 基线 ref (capabilities.git_diff=true 时用)。
 * @param options.beforeSnapshot 派出前的 fs snapshot (capabilities.fs_snapshot=true 时用)。
 * @param options.earlierTaskWrites 跨 task 路径归属表 (task_id → 实际写入列表),
 *   用于越界检测第 2 层。
 *
 * Notes:
 * - 失败 / plan_amendment outcome 也走本函数, 但 actual_writes / eval_result 会以
 *   空集 / 全 fail 形态返回 (caller 据 outcome.status 决定后续)。
 * - after_snapshot 在本函数内即时取 (worker 交回那一刻)。
 * - eval_result 用 outcome.test_results (若 null, 用全空 TestResults 兜底, evalTask
 *   自然产出全 fail 的 case_results)。
 */
export function collectOutcome(
  task: Task,
  outcome: WorkerOutcome,
  packet: WorkerPacket,
  capabilities: RunCapabilities,
  options?: {
    baseRef?: string | null;
    beforeSnapshot?: FsSnapshot | null;
    earlierTaskWrites?: Record<string, string[]> | null;
  },
): CollectedTaskResult {
  const baseRef = options?.baseRef ?? null;
  const beforeSnapshot = options?.beforeSnapshot ?? null;
  const earlierTaskWrites = options?.earlierTaskWrites ?? null;

  // 1. actual_writes 采集 (§3.4 三层优先级)
  let afterSnapshot: FsSnapshot | null = null;
  if (capabilities.fs_snapshot && beforeSnapshot !== null) {
    afterSnapshot = takeFsSnapshot(packet.workdir);
  }

  // outcome=failed/plan_amendment 时 test_results 多半为 null, 用空集让 evalTask 自然全 fail。
  const testResults: TestResults = outcome.test_results ?? {
    tests_green: false,
    cases: [],
  };

  const actualWrites = collectActualWrites(packet.workdir, task.id, capabilities, {
    baseRef,
    beforeSnapshot,
    afterSnapshot,
    // 无独立采集能力时, self_report 留空 (与 Python collect.py 行为一致: source 退化为空集)。
    workerSelfReport: [],
  });

  // 2. 越界检测 (§3.4 两层)
  const oob = detectOutOfBounds(task, actualWrites, {
    pathOverlapFn: pathGlobsOverlap,
    earlierTaskWrites,
  });

  // 3. S4 checks 求值
  const evalResult = evalTask(testResults, [...task.tests], task.id);

  // 4. S7 任务自检 (eval_result.tests_green 不信 worker 自报, §0.2)
  const taskCheckResult = checkTask(task, testResults, evalResult, {
    oob,
    activeTasks: null, // 跨 task 路径冲突由 §3.2 conflicts 在调度期挡, 这里只看本 task
    pathOverlapFn: pathGlobsOverlap,
  });

  return {
    task_id: task.id,
    outcome,
    actual_writes: actualWrites,
    oob,
    eval_result: evalResult,
    task_check_result: taskCheckResult,
    packet,
  };
}
