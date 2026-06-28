"""AC ↔ task 双向索引 (design §3.6).

规范源: design §3.6 (plan-amendment 的并发回滚).

worker 报 plan-amendment-needed 必带 touched_acceptance_refs, coordinator 反查
AC ↔ task 映射后做回滚判定 (见 rollback.py). 本模块只负责构建和查询索引,
不参与回滚决策.

约定:
- 一条 acceptance_ref (AC id) 可能被多个 task 引用 (多对多).
- 一个 task 的 acceptance_refs 是 list, 可能为空 (无 AC 锚点的纯辅助 task).
- 索引构建是 O(n) 扫描 plan.tasks, n = task 数.

排序稳定性:
- ac_to_tasks 的 value 列表按 task.id 字典序, 保证回滚范围判定可复现.
- task_to_acs 的 value 列表按 plan 中出现顺序 (task.acceptance_refs 原顺序),
  保留作者意图 (有时 AC 编号隐含执行顺序).
- 同一 task 的 acceptance_refs 里若同一 AC 重复出现 (异常但 schema 允许),
  索引去重后保留单一出现.
"""
from __future__ import annotations

from loop_engineering.schema.task_plan import TaskPlan


def build_ac_to_tasks(plan: TaskPlan) -> dict[str, list[str]]:
    """构建 AC id → 拥有该 AC 的 task id 列表.

    Args:
        plan: task-plan 模型.

    Returns:
        dict[str, list[str]]: AC id → task id 列表 (按 task.id 字典序, 去重).
        没有 acceptance_refs 的 task 不出现在任何 value 中.
    """
    bucket: dict[str, set[str]] = {}
    for task in plan.tasks:
        if not task.acceptance_refs:
            continue
        # 同 task 内去重 (异常输入防御)
        for ac in dict.fromkeys(task.acceptance_refs):
            bucket.setdefault(ac, set()).add(task.id)
    return {ac: sorted(task_ids) for ac, task_ids in bucket.items()}


def build_task_to_acs(plan: TaskPlan) -> dict[str, list[str]]:
    """构建 task id → 该 task 的 acceptance_refs 列表.

    Args:
        plan: task-plan 模型.

    Returns:
        dict[str, list[str]]: task id → acceptance_refs (按 plan 中出现顺序, 去重).
        acceptance_refs 为空的 task 也以空列表出现, 便于下游用 .get(id, []) 统一处理.
    """
    index: dict[str, list[str]] = {}
    for task in plan.tasks:
        # 去重保序 (dict.fromkeys 在 3.7+ 保插入顺序)
        index[task.id] = list(dict.fromkeys(task.acceptance_refs))
    return index


def tasks_for_ac(ac_index: dict[str, list[str]], ac_id: str) -> list[str]:
    """查表 helper: 给定 AC, 返回拥有它的 task id 列表.

    不存在则返回空列表 (不报错, 让调用方按"无相交"处理).
    """
    return list(ac_index.get(ac_id, []))


def acs_for_task(task_index: dict[str, list[str]], task_id: str) -> list[str]:
    """查表 helper: 给定 task, 返回它的 acceptance_refs.

    不存在则返回空列表 (例如 task 已从 plan 移除或 id 拼错).
    """
    return list(task_index.get(task_id, []))
