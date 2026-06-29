/**
 * runtime 子包汇总导出 (P5-M7A, 等价 Python `loop_engineering/runtime/`)。
 *
 * 模块映射 (Python → TS):
 * - directory.py    → directory.ts   (run 目录布局 + run-state.json / task-plan.yaml 原子读写,
 *                                      Windows 杀软扫描下 rename 重试 5 次退避 25ms, design 坑点)
 * - tick.py         → tick.ts        (纯函数, 严格固定顺序 design §3.7)
 * - coordinator.py  → coordinator.ts (run-state.json 与 task-plan.yaml 单写者; 持 state+plan;
 *                                      跨进程恢复时从 yaml 读回 plan, 否则后续命令断链)
 * - (新增) yaml_io.ts                 (task-plan.yaml / key-diffs.yaml 序列化, 对齐 Python
 *                                      model_dump + yaml.safe_dump 的字段顺序与 exclude_none 语义)
 */
export * from "./directory.js";
export * from "./yaml_io.js";
export * from "./tick.js";
export * from "./coordinator.js";
export * from "./navigation_map.js";
