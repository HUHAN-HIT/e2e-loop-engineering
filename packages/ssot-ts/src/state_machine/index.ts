/**
 * state_machine 子包汇总导出 (P4-M2, 等价 Python `loop_engineering/state_machine/`)。
 *
 * 两个模块:
 * - transitions: phase 迁移合法性矩阵 + advancePhase。
 * - human_anchors: 人盯锚点与 phase 的合法性矩阵。
 */
export * from "./transitions.js";
export * from "./human_anchors.js";
export * from "./plan_auto_accept.js";
