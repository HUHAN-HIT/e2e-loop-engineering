/**
 * 4 hook logic 层统一导出 (§5.2 宿主无关层)。
 *
 * 每个 hook 的 handle(input): Promise<HookOutput> 是纯函数 + 显式副作用
 * (post_task_collect 通过 HookOutput.sideEffect 落 actual-writes.json)。
 * adapter (CC / OC) 在 binding 时翻译 HookOutput → 宿主原生 payload。
 *
 * 公共底座 (common.ts) 与 actual_writes 采集 (actual_writes.ts) 也一并导出,
 * 供 adapter / 测试 / 未来 hook 复用。
 */

export {
  classifyWorker,
  deny,
  findActiveTask,
  injectContext,
  normalizeToolFilePath,
  passSilent,
  relToRepo,
  safeReadRunState,
  safeReadTaskPlan,
  WORKER_CLARIFICATION,
  WORKER_IMPLEMENTATION,
  WORKER_PLAN,
  WORKER_RED_TEAM,
  type WorkerName,
} from "./common.js";

export { handle as handleProbeAndGate, probeCapabilities, probeUnattendedReadiness, type Capabilities } from "./probe_and_gate/logic.js";
export { handle as handleGuardPaths } from "./guard_paths/logic.js";
export { handle as handlePostTaskCollect } from "./post_task_collect/logic.js";
export { handle as handleGuardAnchors } from "./guard_anchors/logic.js";
