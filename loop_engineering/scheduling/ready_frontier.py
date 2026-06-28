"""调度: ready frontier (design §3.2).

唯一规范源: design §3.2 ready_frontier 伪代码 + §11.1 conflicts service-aware 修正.

关键修正 (design §3.2 原文): "候选不仅和 active 比, 还要和本批已选候选两两比"
—— 通过 `committed = list(active_tasks) + 本批已选` 实现.

本函数**只选, 不翻转** status (design §3.2: 调用方拿到 ready 后, 由 coordinator
负责把 status 从 pending 翻 running).
"""
from __future__ import annotations

from ..schema.task_plan import Task, TaskStatus
from .path_overlap import conflicts

__all__ = ["ready_frontier"]


def ready_frontier(tasks: list[Task], active_tasks: list[Task]) -> list[Task]:
    """选本 tick 可派发的 pending task (design §3.2).

    过滤规则 (按短路顺序):
    1. status 非 pending → 跳过.
    2. depends_on 任一未 complete → 跳过.
    3. 与 active 或本批已选任一冲突 → 跳过.
    4. exclusive 且 committed 非空 → 跳过 (独占本服务一批).

    排序: 按 task.id 字典序稳定遍历, 保证多次调用结果一致.
    """
    # 反查 id → Task, 用于 depends_on 求值.
    by_id: dict[str, Task] = {t.id: t for t in tasks}

    # 按字典序稳定排序 (复制一份, 不改调用方输入).
    ordered = sorted(tasks, key=lambda t: t.id)

    ready: list[Task] = []
    committed: list[Task] = list(active_tasks)

    for task in ordered:
        # 规则 1: 仅 pending 才入选.
        if task.status != TaskStatus.pending:
            continue
        # 规则 2: depends_on 必须全部 complete.
        deps_ok = True
        for dep_id in task.depends_on:
            dep = by_id.get(dep_id)
            # 依赖不存在 (悬空 id): 保守视为未满足, 跳过.
            if dep is None or dep.status != TaskStatus.complete:
                deps_ok = False
                break
        if not deps_ok:
            continue
        # 规则 3: 与 active + 本批已选两两不冲突.
        if any(conflicts(task, other) for other in committed):
            continue
        # 规则 4: exclusive 独占本服务一批 (committed 非空即让位).
        if task.exclusive and committed:
            continue
        ready.append(task)
        committed.append(task)

    return ready
