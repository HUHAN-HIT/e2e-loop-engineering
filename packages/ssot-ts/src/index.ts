/**
 * @e2e-loop/ssot 顶层入口 —— TS 实现的算法 SSOT。
 *
 * P4 已完成从 Python `loop_engineering/` 迁移的 M1-M6 子包:
 *   schema / state_machine / scheduling / checklists / amendment / multi_service / trust_mode
 * 每子包由 tests-ts/ssot/ 下的等价测试守护 (用例同源 Python tests/, §9.4)。
 *
 * 导出策略:
 *   - schema 扁平导出 (RunStateSchema / TaskPlanSchema / Phase ... 直接可用)。
 *   - 其余子包用命名空间导出, 规避跨子包同名 (如 schema.ContractChange vs
 *     multiService 的 ContractChange) 引发的重复导出冲突; 也可经子路径
 *     `@e2e-loop/ssot/<subpkg>` 直接 import。
 */

export * from "./schema/index.js";

export * as stateMachine from "./state_machine/index.js";
export * as scheduling from "./scheduling/index.js";
export * as checklists from "./checklists/index.js";
export * as amendment from "./amendment/index.js";
export * as multiService from "./multi_service/index.js";
export * as trustMode from "./trust_mode/index.js";

// P5-M7A: runtime + dispatch (从 Python loop_engineering/{runtime,dispatch} 迁移)。
// 命名空间导出, 与上面其余子包风格一致; 也可经子路径 @e2e-loop/ssot/{runtime,dispatch} import。
export * as runtime from "./runtime/index.js";
export * as dispatch from "./dispatch/index.js";
