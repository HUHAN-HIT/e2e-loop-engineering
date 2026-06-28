/**
 * multi_service 子包汇总导出 (P4-M5, 等价 Python `loop_engineering/multi_service/`)。
 *
 * 3 个模块:
 * - contracts_diff: service-contracts.yaml 版本 diff (契约变更权威判定源)。
 * - propagation: surface 变更的隐式依赖传播闭包。
 * - service_map: service → 物理 worktree 映射与校验。
 */
export * from "./contracts_diff.js";
export * from "./propagation.js";
export * from "./service_map.js";
