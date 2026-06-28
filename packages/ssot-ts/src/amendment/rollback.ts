/**
 * Plan-amendment 回滚算法 (design §3.6, TS 版, 等价 Python `loop_engineering/amendment/rollback.py`)。
 *
 * 规范源: design §3.6 (plan-amendment 的并发回滚)。
 *
 * worker 报 plan-amendment-needed 后, coordinator 用本模块计算回滚范围并应用。
 *
 * 核心规则 (§3.6):
 * 1. amendment 声明 touched_acceptance_refs (必非空)。
 * 2. **保守扩围**: 对每个 declared AC, 找到拥有它的所有 task, 把这些 task 的全部
 *    acceptance_refs 加入扩围集合 (覆盖同 task 邻居 AC, 应对 worker 漏报)。
 * 3. 遍历 plan.tasks 按 task.acceptance_refs ∩ expanded_refs 分类:
 *    - 相交 + status==complete  → downgrade_to_pending
 *    - 相交 + status==running   → recall_to_pending (本次派发作废)
 *    - 相交 + status in {pending, blocked} → untouched
 *      (pending 已在等修订后重派; blocked 永不选中, 不需额外操作)
 *    - 不相交 → untouched
 *
 * 软约束残留 (诚实声明, design §3.6 原文):
 *     仍可能漏掉**跨 task** 的间接影响 (超出声明能反查的范围) ——
 *     这是诚实的软约束残留, 最终靠收口 diff + 人兜底, 机制消除不了。
 *     例: T01 改了某 AC, 间接让 T02 的某条 checks 失效, 但 T02 不直接消费该 AC,
 *     也不和 T01 共享任何 AC —— 这种间接影响本机制发现不了。
 *
 * attempt 不重置的取舍:
 *     applyRollback 不重置 task.attempt。重派时 attempt 是否重置由 coordinator
 *     按 watchdog 规则决定 (§3.6: "重派" 是 coordinator 的事)。本模块保守不动 attempt,
 *     把策略选择留给上层, 避免回滚和 watchdog 两处都改 attempt 造成双重计数。
 */
import type { PlanAmendmentNeeded } from "../schema/artifacts.js";
import type { Task, TaskPlan } from "../schema/task_plan.js";
import { TaskStatus } from "../schema/task_plan.js";
import {
  acsForTask,
  buildAcToTasks,
  buildTaskToAcs,
  tasksForAc,
} from "./ac_index.js";

/**
 * amendment 触发的回滚计划 (在 apply 之前)。
 *
 * 用于诊断 + 日志: coordinator 在拍板前可以先打印这个 plan 给人看,
 * 确认回滚范围合理再 apply。
 *
 * 结构在 computeRollback 返回后视为不可变 (调用方不应改写)。
 */
export interface RollbackPlan {
  /** amendment 声明的 AC (worker 自报告, 可能漏报)。 */
  touched_acceptance_refs: string[];
  /** 保守扩围后的 AC (含同 task 邻居 AC)。用于实际相交判定。 */
  expanded_acceptance_refs: string[];
  /** 要从 complete 降级到 pending 的 task id。 */
  downgrade_to_pending: string[];
  /** 要从 running 召回到 pending 的 task id (本次派发已作废)。 */
  recall_to_pending: string[];
  /** 完全不动的 task id (含不相交 task + 相交但本就 pending/blocked 的 task)。 */
  untouched: string[];
  /**
   * 是否改变验收语义。coordinator 据此决定是否触发计划拍板 (HUMAN-ANCHOR)。
   * True = 改了 AC 的语义 (例如删了一条 AC, 或改了它的 checks), 需要人重新拍板。
   * False = 只是 task 级回滚, 计划语义不变, coordinator 可直接重派。
   */
  changes_semantics: boolean;
}

/**
 * 保守扩围: 把 declared AC 所在 task 的全部 acceptance_refs 纳入。
 *
 * 算法 (design §3.6 "保守扩围"):
 * ```
 * expanded = set()
 * for ac in touched_refs:
 *     for task_id in tasksForAc(ac_index, ac):
 *         expanded |= set(acsForTask(task_index, task_id))
 * return sorted(expanded)
 * ```
 *
 * @param plan 仅用于文档语义, 实际索引由 acIndex/taskIndex 提供。
 * @param acIndex AC → task ids。
 * @param taskIndex task id → AC ids。
 * @param touchedRefs amendment 声明的 AC。
 * @returns 排序去重后的 AC id 列表 (排序保证可复现)。
 */
export function expandAcceptanceRefs(
  plan: TaskPlan,
  acIndex: Record<string, string[]>,
  taskIndex: Record<string, string[]>,
  touchedRefs: Iterable<string>,
): string[] {
  void plan; // plan 不直接参与 (索引已预算); 保留参数为语义清晰 + API 对称
  const expanded = new Set<string>();
  for (const ac of touchedRefs) {
    for (const taskId of tasksForAc(acIndex, ac)) {
      for (const neighbor of acsForTask(taskIndex, taskId)) {
        expanded.add(neighbor);
      }
    }
  }
  return [...expanded].sort();
}

/**
 * 计算回滚计划 (不实际改 plan, 只描述)。
 *
 * @param plan 当前 TaskPlan。
 * @param amendment worker 报上来的 plan-amendment-needed 信号。
 * @param changesSemantics 是否改变验收语义。coordinator 据此决定后续拍板流程。
 * @returns RollbackPlan。
 *
 * 分类规则见模块顶部 docstring。
 */
export function computeRollback(
  plan: TaskPlan,
  amendment: PlanAmendmentNeeded,
  changesSemantics = false,
): RollbackPlan {
  const acIndex = buildAcToTasks(plan);
  const taskIndex = buildTaskToAcs(plan);

  const touched = [...amendment.touched_acceptance_refs];
  const expanded = expandAcceptanceRefs(plan, acIndex, taskIndex, touched);
  const expandedSet = new Set(expanded);

  const downgrade: string[] = [];
  const recall: string[] = [];
  const untouched: string[] = [];

  for (const task of plan.tasks) {
    const taskAcs = acsForTask(taskIndex, task.id);
    const intersects = taskAcs.some((ac) => expandedSet.has(ac));
    if (!intersects) {
      untouched.push(task.id);
      continue;
    }
    // 相交: 按状态分类
    if (task.status === TaskStatus.complete) {
      downgrade.push(task.id);
    } else if (task.status === TaskStatus.running) {
      recall.push(task.id);
    } else {
      // pending / blocked: 本就在等或永不选中, 无需回滚操作。
      // 注意: pending 相交 task 会按修订后的计划自然重派 (coordinator 负责),
      // 本函数无需额外操作, 故归入 untouched。
      untouched.push(task.id);
    }
  }

  return {
    touched_acceptance_refs: [...touched],
    expanded_acceptance_refs: expanded,
    downgrade_to_pending: downgrade,
    recall_to_pending: recall,
    untouched,
    changes_semantics: changesSemantics,
  };
}

/**
 * 应用回滚计划, 返回**新** TaskPlan (不可变风格)。
 *
 * @param plan 原 TaskPlan (不被修改)。
 * @param rollback computeRollback 的结果。
 * @returns 新 TaskPlan, 其中:
 *   - downgrade_to_pending 的 task: status → pending, attempt 不重置。
 *   - recall_to_pending 的 task: status → pending, attempt 不重置
 *     (本次派发已作废, coordinator 重派时按 watchdog 规则处理新 attempt)。
 *   - untouched: 保持原状 (含所有字段)。
 *
 * Note:
 *   不动 task.status 之外的字段 (allowed_write_paths / depends_on /
 *   acceptance_refs / risk / tests / attempt / 多服务字段全部保留)。
 */
export function applyRollback(plan: TaskPlan, rollback: RollbackPlan): TaskPlan {
  const downgradeSet = new Set(rollback.downgrade_to_pending);
  const recallSet = new Set(rollback.recall_to_pending);

  const mapTask = (t: Task): Task => {
    if (downgradeSet.has(t.id) || recallSet.has(t.id)) {
      // 浅拷贝 + 仅改 status: 其他字段引用共享 (等价 Python model_copy(update={...}))。
      return { ...t, status: TaskStatus.pending };
    }
    return t;
  };

  const newTasks = plan.tasks.map(mapTask);
  return { ...plan, tasks: newTasks };
}

/**
 * 给人看的回滚范围摘要 (coordinator 在 amendment 后向人解释用)。
 *
 * 输出形如:
 * ```
 * plan-amendment 回滚 (changes_semantics=false):
 *   声明 AC: AC-001
 *   扩围 AC: AC-001, AC-002
 *   降级 complete→pending: T01
 *   召回 running→pending:  T02
 *   不动: T03, T04
 * ```
 */
export function summarize(rollback: RollbackPlan): string {
  const fmt = (items: string[]): string =>
    items.length > 0 ? items.join(", ") : "(无)";

  return (
    `plan-amendment 回滚 (changes_semantics=${rollback.changes_semantics}):\n` +
    `  声明 AC: ${fmt(rollback.touched_acceptance_refs)}\n` +
    `  扩围 AC: ${fmt(rollback.expanded_acceptance_refs)}\n` +
    `  降级 complete→pending: ${fmt(rollback.downgrade_to_pending)}\n` +
    `  召回 running→pending:  ${fmt(rollback.recall_to_pending)}\n` +
    `  不动: ${fmt(rollback.untouched)}`
  );
}
