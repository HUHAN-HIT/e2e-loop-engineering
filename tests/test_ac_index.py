"""tests for loop_engineering.amendment.ac_index."""
from __future__ import annotations

from loop_engineering.amendment.ac_index import (
    acs_for_task,
    build_ac_to_tasks,
    build_task_to_acs,
    tasks_for_ac,
)
from loop_engineering.schema.task_plan import Task, TaskPlan


def _plan(*tasks: Task) -> TaskPlan:
    """构造最小 TaskPlan (complexity 随意, 不参与索引)."""
    return TaskPlan(complexity="simple", tasks=list(tasks))


def _task(tid: str, acs: list[str]) -> Task:
    return Task(
        id=tid,
        title=f"task {tid}",
        allowed_write_paths=[f"src/{tid}/**"],
        acceptance_refs=list(acs),
    )


def test_build_ac_to_tasks_basic() -> None:
    """T01[AC-001,AC-002] + T02[AC-002,AC-003] → 多对多映射."""
    plan = _plan(_task("T01", ["AC-001", "AC-002"]), _task("T02", ["AC-002", "AC-003"]))
    idx = build_ac_to_tasks(plan)
    assert idx == {"AC-001": ["T01"], "AC-002": ["T01", "T02"], "AC-003": ["T02"]}


def test_build_task_to_acs_basic() -> None:
    """反向索引: task → ACs, 保序."""
    plan = _plan(_task("T01", ["AC-001", "AC-002"]), _task("T02", ["AC-002", "AC-003"]))
    idx = build_task_to_acs(plan)
    assert idx == {"T01": ["AC-001", "AC-002"], "T02": ["AC-002", "AC-003"]}


def test_index_for_plan_with_no_ac_refs() -> None:
    """无 AC 的 task 不出现在 ac_index; task_index 中以空列表出现."""
    plan = _plan(_task("T01", []), _task("T02", ["AC-001"]))
    ac_idx = build_ac_to_tasks(plan)
    task_idx = build_task_to_acs(plan)
    # T01 不在任何 AC value 中
    assert all("T01" not in v for v in ac_idx.values())
    assert ac_idx == {"AC-001": ["T02"]}
    # T01 仍以空列表出现
    assert task_idx == {"T01": [], "T02": ["AC-001"]}


def test_index_ordering_stable() -> None:
    """多 task 共享 AC 时按 task.id 字典序."""
    # 故意以非字典序插入
    plan = _plan(
        _task("TZ", ["AC-001"]),
        _task("TA", ["AC-001"]),
        _task("TM", ["AC-001"]),
    )
    idx = build_ac_to_tasks(plan)
    assert idx["AC-001"] == ["TA", "TM", "TZ"]


def test_tasks_for_ac_missing_returns_empty() -> None:
    """查表 helper: 缺失 AC 返回空列表 (不报错)."""
    idx = {"AC-001": ["T01"]}
    assert tasks_for_ac(idx, "AC-001") == ["T01"]
    assert tasks_for_ac(idx, "AC-999") == []


def test_acs_for_task_missing_returns_empty() -> None:
    """查表 helper: 缺失 task 返回空列表."""
    idx = {"T01": ["AC-001"]}
    assert acs_for_task(idx, "T01") == ["AC-001"]
    assert acs_for_task(idx, "T999") == []


def test_index_handles_duplicate_ac_in_single_task() -> None:
    """同一 task 同一 AC 重复出现 (异常但 schema 允许) → 去重."""
    plan = _plan(_task("T01", ["AC-001", "AC-001", "AC-002"]))
    ac_idx = build_ac_to_tasks(plan)
    task_idx = build_task_to_acs(plan)
    # AC → task 去重
    assert ac_idx == {"AC-001": ["T01"], "AC-002": ["T01"]}
    # task → AC 去重保序
    assert task_idx == {"T01": ["AC-001", "AC-002"]}
