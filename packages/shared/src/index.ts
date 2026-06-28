/**
 * @e2e-loop/shared - 跨 adapter 共享层
 *
 * 规范源: docs/loop-engineering-cross-host-design.md §5 / §8。
 *
 * 导出:
 * - types: HostAdapter / HostHook / HookInput / HookOutput / SideEffect / HookFeatures 等
 * - path_match: glob + 前缀匹配 (guard_paths 用)
 * - runs: run 目录扫描与 run-state.json 读取
 * - run_state: RunState / Phase / Complexity 等类型
 * - task_plan: task-plan.yaml 读取
 * - actual_writes: §3.4 三层采集 + 越界检测 (行为权威: Python scheduling/actual_writes.py)
 * - hooks: 4 个 hook 的宿主无关 logic 层 (probe_and_gate / guard_paths /
 *          post_task_collect / guard_anchors) + 公共底座
 */

export * from "./types.js";
export * from "./path_match.js";
export * from "./run_state.js";
export * from "./runs.js";
export * from "./task_plan.js";
export * from "./actual_writes.js";
export * from "./hooks/index.js";
