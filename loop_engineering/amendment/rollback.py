"""Plan-amendment 回滚算法 (design §3.6).

规范源: design §3.6 (plan-amendment 的并发回滚).

worker 报 plan-amendment-needed 后, coordinator 用本模块计算回滚范围并应用.

核心规则 (§3.6):
1. amendment 声明 touched_acceptance_refs (必非空).
2. **保守扩围**: 对每个 declared AC, 找到拥有它的所有 task, 把这些 task 的全部
   acceptance_refs 加入扩围集合 (覆盖同 task 邻居 AC, 应对 worker 漏报).
3. 遍历 plan.tasks 按 task.acceptance_refs ∩ expanded_refs 分类:
   - 相交 + status==complete  → downgrade_to_pending
   - 相交 + status==running   → recall_to_pending (本次派发作废)
   - 相交 + status in {pending, blocked} → untouched
     (pending 已在等修订后重派; blocked 永不选中, 不需额外操作)
   - 不相交 → untouched

软约束残留 (诚实声明, design §3.6 原文):
    仍可能漏掉**跨 task** 的间接影响 (超出声明能反查的范围) ——
    这是诚实的软约束残留, 最终靠收口 diff + 人兜底, 机制消除不了.
    例: T01 改了某 AC, 间接让 T02 的某条 checks 失效, 但 T02 不直接消费该 AC,
    也不和 T01 共享任何 AC —— 这种间接影响本机制发现不了.

attempt 不重置的取舍:
    apply_rollback 不重置 task.attempt. 重派时 attempt 是否重置由 coordinator
    按 watchdog 规则决定 (§3.6: "重派" 是 coordinator 的事). 本模块保守不动 attempt,
    把策略选择留给上层, 避免回滚和 watchdog 两处都改 attempt 造成双重计数.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

from loop_engineering.schema.artifacts import PlanAmendmentNeeded
from loop_engineering.schema.task_plan import Task, TaskPlan, TaskStatus
from loop_engineering.amendment.ac_index import (
    acs_for_task,
    build_ac_to_tasks,
    build_task_to_acs,
    tasks_for_ac,
)


@dataclass(frozen=True)
class RollbackPlan:
    """amendment 触发的回滚计划 (在 apply 之前).

    用于诊断 + 日志: coordinator 在拍板前可以先 print 这个 plan 给人看,
    确认回滚范围合理再 apply.

    frozen=True: 一旦 compute_rollback 返回就不可变, 防止下游误改.
    """

    touched_acceptance_refs: list[str]
    """amendment 声明的 AC (worker 自报告, 可能漏报)."""

    expanded_acceptance_refs: list[str]
    """保守扩围后的 AC (含同 task 邻居 AC). 用于实际相交判定."""

    downgrade_to_pending: list[str]
    """要从 complete 降级到 pending 的 task id."""

    recall_to_pending: list[str]
    """要从 running 召回到 pending 的 task id (本次派发已作废)."""

    untouched: list[str]
    """完全不动的 task id (含不相交 task + 相交但本就 pending/blocked 的 task)."""

    changes_semantics: bool
    """是否改变验收语义. coordinator 据此决定是否触发计划拍板 (HUMAN-ANCHOR).
    True = 改了 AC 的语义 (例如删了一条 AC, 或改了它的 checks), 需要人重新拍板.
    False = 只是 task 级回滚, 计划语义不变, coordinator 可直接重派.
    """


def expand_acceptance_refs(
    plan: TaskPlan,
    ac_index: dict[str, list[str]],
    task_index: dict[str, list[str]],
    touched_refs: Iterable[str],
) -> list[str]:
    """保守扩围: 把 declared AC 所在 task 的全部 acceptance_refs 纳入.

    算法 (design §3.6 "保守扩围"):
        expanded = set()
        for ac in touched_refs:
            for task_id in tasks_for_ac(ac_index, ac):
                expanded |= set(acs_for_task(task_index, task_id))
        return sorted(expanded)

    Args:
        plan: 仅用于文档语义, 实际索引由 ac_index/task_index 提供.
        ac_index: AC → task ids.
        task_index: task id → AC ids.
        touched_refs: amendment 声明的 AC.

    Returns:
        排序去重后的 AC id 列表 (排序保证可复现).
    """
    _ = plan  # plan 不直接参与 (索引已预算); 保留参数为语义清晰 + API 对称
    expanded: set[str] = set()
    for ac in touched_refs:
        for task_id in tasks_for_ac(ac_index, ac):
            expanded.update(acs_for_task(task_index, task_id))
    return sorted(expanded)


def compute_rollback(
    plan: TaskPlan,
    amendment: PlanAmendmentNeeded,
    *,
    changes_semantics: bool = False,
) -> RollbackPlan:
    """计算回滚计划 (不实际改 plan, 只描述).

    Args:
        plan: 当前 TaskPlan.
        amendment: worker 报上来的 plan-amendment-needed 信号.
        changes_semantics: 是否改变验收语义. coordinator 据此决定后续拍板流程.

    Returns:
        RollbackPlan (frozen, 不可变).

    分类规则见模块 docstring.
    """
    ac_index = build_ac_to_tasks(plan)
    task_index = build_task_to_acs(plan)

    touched = list(amendment.touched_acceptance_refs)
    expanded = expand_acceptance_refs(plan, ac_index, task_index, touched)
    expanded_set = set(expanded)

    downgrade: list[str] = []
    recall: list[str] = []
    untouched: list[str] = []

    for task in plan.tasks:
        task_acs = set(acs_for_task(task_index, task.id))
        intersects = bool(task_acs & expanded_set)
        if not intersects:
            untouched.append(task.id)
            continue
        # 相交: 按状态分类
        if task.status == TaskStatus.complete:
            downgrade.append(task.id)
        elif task.status == TaskStatus.running:
            recall.append(task.id)
        else:
            # pending / blocked: 本就在等或永不选中, 无需回滚操作.
            # 注意: pending 相交 task 会按修订后的计划自然重派 (coordinator 负责),
            # 本函数无需额外操作, 故归入 untouched.
            untouched.append(task.id)

    return RollbackPlan(
        touched_acceptance_refs=list(touched),
        expanded_acceptance_refs=expanded,
        downgrade_to_pending=downgrade,
        recall_to_pending=recall,
        untouched=untouched,
        changes_semantics=changes_semantics,
    )


def apply_rollback(plan: TaskPlan, rollback: RollbackPlan) -> TaskPlan:
    """应用回滚计划, 返回**新** TaskPlan (不可变风格).

    Args:
        plan: 原 TaskPlan (不被修改).
        rollback: compute_rollback 的结果.

    Returns:
        新 TaskPlan, 其中:
        - downgrade_to_pending 的 task: status → pending, attempt 不重置.
        - recall_to_pending 的 task: status → pending, attempt 不重置
          (本次派发已作废, coordinator 重派时按 watchdog 规则处理新 attempt).
        - untouched: 保持原状 (含所有字段).

    Note:
        不动 task.status 之外的字段 (allowed_write_paths / depends_on /
        acceptance_refs / risk / tests / attempt / 多服务字段全部保留).
    """
    downgrade_set = set(rollback.downgrade_to_pending)
    recall_set = set(rollback.recall_to_pending)

    def _map_task(t: Task) -> Task:
        if t.id in downgrade_set or t.id in recall_set:
            # model_copy 浅拷贝足够: 只改 status, 其他字段引用共享 (Task 字段多为不可变)
            return t.model_copy(update={"status": TaskStatus.pending})
        return t

    new_tasks = [_map_task(t) for t in plan.tasks]
    return plan.model_copy(update={"tasks": new_tasks})


def summarize(rollback: RollbackPlan) -> str:
    """给人看的回滚范围摘要 (coordinator 在 amendment 后向人解释用).

    输出形如::

        plan-amendment 回滚 (changes_semantics=False):
          声明 AC: AC-001
          扩围 AC: AC-001, AC-002
          降级 complete→pending: T01
          召回 running→pending:  T02
          不动: T03, T04
    """
    def _fmt(items: list[str]) -> str:
        return ", ".join(items) if items else "(无)"

    return (
        f"plan-amendment 回滚 (changes_semantics={rollback.changes_semantics}):\n"
        f"  声明 AC: {_fmt(rollback.touched_acceptance_refs)}\n"
        f"  扩围 AC: {_fmt(rollback.expanded_acceptance_refs)}\n"
        f"  降级 complete→pending: {_fmt(rollback.downgrade_to_pending)}\n"
        f"  召回 running→pending:  {_fmt(rollback.recall_to_pending)}\n"
        f"  不动: {_fmt(rollback.untouched)}"
    )
