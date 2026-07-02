/**
 * task detail 模型 (planning/task-details/<task-id>.yaml)。
 *
 * detail 文件承载当前 task 的业务实现指导、验收解释、planned case 映射和 review focus。
 * 它不拥有机器关键字段: allowed_write_paths / tests / dependencies / status 仍以 task-plan.yaml 为准。
 */
import { z } from "zod";

export const AcceptanceContextSchema = z.object({
  ref: z.string(),
  intent: z.string().default(""),
  observable_behavior: z.string().default(""),
  implementation_implications: z.array(z.string()).default([]),
});
export type AcceptanceContext = z.infer<typeof AcceptanceContextSchema>;

export const VerificationMapEntrySchema = z.object({
  acceptance_ref: z.string(),
  planned_cases: z.array(z.string()).default([]),
  notes: z.string().default(""),
});
export type VerificationMapEntry = z.infer<typeof VerificationMapEntrySchema>;

export const TaskDetailSchema = z.object({
  schema: z.string().default("loop-engineering.task-detail.v1"),
  task_id: z.string(),
  summary: z.string().default(""),
  business_logic_steps: z.array(z.string()).default([]),
  files_to_inspect: z.array(z.string()).default([]),
  implementation_notes: z.array(z.string()).default([]),
  acceptance_context: z.array(AcceptanceContextSchema).default([]),
  verification_map: z.array(VerificationMapEntrySchema).default([]),
  review_focus: z.array(z.string()).default([]),
  test_focus: z.array(z.string()).default([]),
});
export type TaskDetail = z.infer<typeof TaskDetailSchema>;

export function parseTaskDetail(data: unknown): TaskDetail {
  return TaskDetailSchema.parse(data);
}
