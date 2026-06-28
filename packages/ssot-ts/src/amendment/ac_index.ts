/**
 * AC ↔ task 双向索引 (design §3.6, TS 版, 等价 Python `loop_engineering/amendment/ac_index.py`)。
 *
 * 规范源: design §3.6 (plan-amendment 的并发回滚)。
 *
 * worker 报 plan-amendment-needed 必带 touched_acceptance_refs, coordinator 反查
 * AC ↔ task 映射后做回滚判定 (见 rollback.ts)。本模块只负责构建和查询索引,
 * 不参与回滚决策。
 *
 * 约定:
 * - 一条 acceptance_ref (AC id) 可能被多个 task 引用 (多对多)。
 * - 一个 task 的 acceptance_refs 是数组, 可能为空 (无 AC 锚点的纯辅助 task)。
 * - 索引构建是 O(n) 扫描 plan.tasks, n = task 数。
 *
 * 排序稳定性:
 * - ac_to_tasks 的 value 列表按 task.id 字典序, 保证回滚范围判定可复现。
 * - task_to_acs 的 value 列表按 plan 中出现顺序 (task.acceptance_refs 原顺序),
 *   保留作者意图 (有时 AC 编号隐含执行顺序)。
 * - 同一 task 的 acceptance_refs 里若同一 AC 重复出现 (异常但 schema 允许),
 *   索引去重后保留单一出现。
 */
import type { TaskPlan } from "../schema/task_plan.js";

/**
 * 去重保序 (等价 Python `dict.fromkeys(...)` 在 3.7+ 的插入序去重)。
 */
function uniquePreserveOrder(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    if (!seen.has(it)) {
      seen.add(it);
      out.push(it);
    }
  }
  return out;
}

/**
 * 构建 AC id → 拥有该 AC 的 task id 列表。
 *
 * @param plan task-plan 模型。
 * @returns AC id → task id 列表 (按 task.id 字典序, 去重)。
 *   没有 acceptance_refs 的 task 不出现在任何 value 中。
 */
export function buildAcToTasks(plan: TaskPlan): Record<string, string[]> {
  const bucket = new Map<string, Set<string>>();
  for (const task of plan.tasks) {
    if (!task.acceptance_refs || task.acceptance_refs.length === 0) {
      continue;
    }
    // 同 task 内去重 (异常输入防御)
    for (const ac of uniquePreserveOrder(task.acceptance_refs)) {
      let s = bucket.get(ac);
      if (s === undefined) {
        s = new Set<string>();
        bucket.set(ac, s);
      }
      s.add(task.id);
    }
  }
  const result: Record<string, string[]> = {};
  for (const [ac, taskIds] of bucket) {
    result[ac] = [...taskIds].sort();
  }
  return result;
}

/**
 * 构建 task id → 该 task 的 acceptance_refs 列表。
 *
 * @param plan task-plan 模型。
 * @returns task id → acceptance_refs (按 plan 中出现顺序, 去重)。
 *   acceptance_refs 为空的 task 也以空列表出现, 便于下游用 `index[id] ?? []` 统一处理。
 */
export function buildTaskToAcs(plan: TaskPlan): Record<string, string[]> {
  const index: Record<string, string[]> = {};
  for (const task of plan.tasks) {
    // 去重保序
    index[task.id] = uniquePreserveOrder(task.acceptance_refs);
  }
  return index;
}

/**
 * 查表 helper: 给定 AC, 返回拥有它的 task id 列表。
 *
 * 不存在则返回空列表 (不报错, 让调用方按"无相交"处理)。
 */
export function tasksForAc(
  acIndex: Record<string, string[]>,
  acId: string,
): string[] {
  return [...(acIndex[acId] ?? [])];
}

/**
 * 查表 helper: 给定 task, 返回它的 acceptance_refs。
 *
 * 不存在则返回空列表 (例如 task 已从 plan 移除或 id 拼错)。
 */
export function acsForTask(
  taskIndex: Record<string, string[]>,
  taskId: string,
): string[] {
  return [...(taskIndex[taskId] ?? [])];
}
