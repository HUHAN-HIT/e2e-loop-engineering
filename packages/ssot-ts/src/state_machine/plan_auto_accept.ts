/**
 * simple 免签判据 (spec 2026-07-01)。
 *
 * plan_check 通过后由 Coordinator.submitPlan 调用: 返回 true → 自动接受计划进 IMPLEMENTING
 * (不设 plan_signoff); false → 退化为现有人工 plan_signoff 停人。
 *
 * 与 submitWrapUp 的条件锚点判据 (risk:high / exclusive 一票否决) 同构, 额外加复杂度闸
 * (仅 simple) + 契约闸 + opt-out 开关。IO (契约文件是否存在) 由调用侧探好传入, 本函数保持纯。
 */
import { RiskLevel } from "../schema/task_plan.js";
import type { Task } from "../schema/task_plan.js";
import type { Complexity } from "../schema/run_state.js";

/** shouldAutoAcceptPlan 入参。契约文件是否存在等 IO 由调用侧探好传入。 */
export interface AutoAcceptInput {
  complexity: Complexity;
  tasks: readonly Task[];
  requirePlanSignoff: boolean;
  hasServiceContracts: boolean;
}

/**
 * 免签判据: 全部条件同时满足才返回 true。
 * 任一不满足 → false (调用侧退化为人工 plan_signoff)。
 */
export function shouldAutoAcceptPlan(input: AutoAcceptInput): boolean {
  if (input.complexity !== "simple") return false; // 复杂度闸: 仅 simple
  if (input.requirePlanSignoff) return false; // opt-out 开关强制门禁
  if (input.hasServiceContracts) return false; // 风险闸③: 契约=跨服务
  if (input.tasks.some((t) => t.risk === RiskLevel.high)) return false; // 风险闸①
  if (input.tasks.some((t) => t.exclusive)) return false; // 风险闸②
  return true;
}
