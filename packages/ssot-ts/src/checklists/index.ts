/**
 * checklists 子包汇总导出 (P4-M2 + P4-M4, 等价 Python `loop_engineering/checklists/`)。
 *
 * 模块映射 (Python → TS):
 * - checks_eval.py    → checks_eval.ts    (M2: parseCheck/evalCheck/evalCase/evalTask 文法求值)
 * - plan_check.py     → plan_check.ts     (M4: §2.1 计划自检 + §11.2 多服务契约自检)
 * - task_check.py     → task_check.ts     (M4: §2.2 task 级自检)
 * - wrap_up_check.py  → wrap_up_check.ts  (M4: §2.3 收口自检 + §11.3 集成自检)
 * - key_diffs_gate.py → key_diffs_gate.ts (M4: risk:high/exclusive task 的 key-diffs 硬 gate)
 *
 * 注意: plan_check 与 task_check 都导出 `PathOverlapFn` 类型, 为避免 `export *` 名字冲突,
 * 此处显式 re-export, `PathOverlapFn` 只从 plan_check 透出一次 (两处定义结构相同)。
 */

// M2: checks 文法求值 (整模块 re-export, 无名字冲突)。
export * from "./checks_eval.js";

// M4: key-diffs 硬 gate (无名字冲突)。
export * from "./key_diffs_gate.js";

// M4: 计划自检 (PathOverlapFn 由本模块统一透出)。
export {
  checkPlan,
  type PathOverlapFn,
  type PlanCheckItem,
  type PlanCheckResult,
} from "./plan_check.js";

// M4: 任务自检 (PathOverlapFn 已由 plan_check 透出, 此处不重复导出)。
export {
  checkTask,
  type OOBDetection,
  type TaskCheckItem,
  type TaskCheckResult,
} from "./task_check.js";

// M4: 收口自检。
export {
  checkWrapUp,
  type WrapUpCheckItem,
  type WrapUpCheckResult,
} from "./wrap_up_check.js";
