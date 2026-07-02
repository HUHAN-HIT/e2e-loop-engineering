/**
 * 任务计划模型 (task-plan.yaml, zod 版, 等价 Python `loop_engineering/schema/task_plan.py`)。
 *
 * 规范源: design §3.1 (极简 task-plan + checks 文法)、§3.2 (task.status 四态)、
 * §11.1 (多服务 task 字段)。
 *
 * schema 层只校验结构, 不解析 checks 文法 (那是 checklists 模块的事)。
 *
 * 与 Pydantic 的差异处理:
 * - Python 端因 `schema` 是 pydantic 保留方法名, 用属性名 `schema_` + `alias="schema"`;
 *   YAML/JSON 真实键始终是 `schema`。TS 无此保留冲突, 故 zod 直接用键名 `schema`,
 *   构造与解析的真实键一致 (相当于 Python `populate_by_name` + alias 的最终效果)。
 * - StrEnum 默认值 / list 默认 [] / bool 默认 → 对应字段 `.default(...)`。
 */
import { z } from "zod";

import { ComplexitySchema } from "./run_state.js";

// ---------------- 枚举 ----------------

/**
 * task.status 四态 (design §3.2)。
 * pending: 可被 ready_frontier 选中。
 * running: worker 已派出、尚未交回。
 * blocked: watchdog 二次回收或自检两次失败后由人接手, 永不选中。
 * complete: worker 交回且自检通过。
 */
export const TaskStatus = {
  pending: "pending",
  running: "running",
  blocked: "blocked",
  complete: "complete",
} as const;
export const TaskStatusSchema = z.enum([
  "pending",
  "running",
  "blocked",
  "complete",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/**
 * task 风险等级 (design §3.1)。
 * high = 控制面核心/安全/数据迁移/不可逆操作; high 在收口前自动触发红队 (§4)。
 */
export const RiskLevel = {
  normal: "normal",
  high: "high",
} as const;
export const RiskLevelSchema = z.enum(["normal", "high"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

// ---------------- 模型 ----------------

/**
 * 单个测试用例 (design §3.1)。
 * checks 是文法字符串列表 (lhs op rhs), 由 checklists 模块机械求值,
 * schema 层不解析内容, 只保证是字符串列表。
 */
export const TestCaseSchema = z.object({
  id: z.string(),
  scenario: z.string(),
  checks: z.array(z.string()),
});
export type TestCase = z.infer<typeof TestCaseSchema>;

/**
 * 单个 task (design §3.1 / §11.1)。
 * 单服务 run 不填 service / provides_contracts / consumes_contracts。
 */
export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  allowed_write_paths: z.array(z.string()),
  acceptance_refs: z.array(z.string()),
  depends_on: z.array(z.string()).default([]),
  exclusive: z.boolean().default(false),
  risk: RiskLevelSchema.default("normal"),
  tests: z.array(TestCaseSchema).default([]),
  status: TaskStatusSchema.default("pending"),
  attempt: z.number().int().default(0),
  /** 当前 task 的长篇指导文件路径, 相对 run root。 */
  detail_ref: z.string().nullish().default(null),
  // 多服务可选 (design §11.1)
  service: z.string().nullish().default(null),
  provides_contracts: z.array(z.string()).default([]),
  consumes_contracts: z.array(z.string()).default([]),
});
export type Task = z.infer<typeof TaskSchema>;

/**
 * task-plan.yaml 顶层模型 (design §3.1)。
 * 真实键 `schema` 默认 "loop-engineering.task-plan.v2"。
 */
export const TaskPlanSchema = z.object({
  schema: z.string().default("loop-engineering.task-plan.v2"),
  complexity: ComplexitySchema,
  tasks: z.array(TaskSchema),
});
export type TaskPlan = z.infer<typeof TaskPlanSchema>;

/**
 * 解析并校验 task-plan 数据 (对齐 Python `TaskPlan.model_validate` / `from_dict`)。
 * 校验失败抛 `ZodError`。
 */
export function parseTaskPlan(data: unknown): TaskPlan {
  return TaskPlanSchema.parse(data);
}
