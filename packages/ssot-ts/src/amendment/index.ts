/**
 * amendment 子包汇总导出 (P4-M5, 等价 Python `loop_engineering/amendment/`)。
 *
 * 2 个模块:
 * - ac_index: AC ↔ task 双向索引 (反查映射)。
 * - rollback: plan-amendment 保守扩围回滚算法。
 */
export * from "./ac_index.js";
export * from "./rollback.js";
