/**
 * scheduling 子包汇总导出 (P4-M3, 等价 Python `loop_engineering/scheduling/`)。
 *
 * 模块映射 (Python → TS):
 * - path_overlap.py    → path_overlap.ts   (pathGlobsOverlap / conflicts, service-aware 写冲突)
 * - ready_frontier.py  → ready_frontier.ts (readyFrontier, DAG 就绪前沿)
 * - watchdog.py        → watchdog.ts       (detectStaleTasks / watchdogTick / ... 超时回收)
 * - capabilities.py    → capabilities.ts   (probeCapabilities, git/fs 能力探测)
 * - actual_writes.py   → 不在本子包重写, 从 `@e2e-loop/shared` re-export (P1 已落地 TS 版)。
 */
export * from "./path_overlap.js";
export * from "./ready_frontier.js";
export * from "./watchdog.js";
export * from "./capabilities.js";

// actual_writes: 复用 shared 的 TS 实现 (不重复造), 在 scheduling 命名空间下统一可见。
export {
  type ActualWrites,
  type ActualWritesSource,
  type BoundaryCheck,
  tryGitDiff,
  tryFsSnapshot,
  extractPathsFromText,
  readSelfReport,
  computeActualWrites,
  checkBoundary,
} from "@e2e-loop/shared";
