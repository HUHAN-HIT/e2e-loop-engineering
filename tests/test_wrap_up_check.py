"""§2.3 收口自检测试 (design §2.3 + §11.3 集成自检)."""
from __future__ import annotations

from loop_engineering.checklists.checks_eval import (
    CaseEvalResult,
    Check,
    CheckEvalResult,
    Op,
    TaskCheckEvalResult,
)
from loop_engineering.checklists.task_check import TaskCheckItem, TaskCheckResult
from loop_engineering.checklists.wrap_up_check import check_wrap_up
from loop_engineering.schema.artifacts import KeyDiffEntry, KeyDiffsFile
from loop_engineering.schema.run_state import Complexity
from loop_engineering.schema.task_plan import RiskLevel, Task, TaskPlan


def _mk_task(tid: str, *, risk: RiskLevel = RiskLevel.normal, exclusive: bool = False) -> Task:
    return Task(
        id=tid,
        title=tid,
        allowed_write_paths=[f"src/{tid}/**"],
        acceptance_refs=[f"AC-{tid}"],
        risk=risk,
        exclusive=exclusive,
    )


def _mk_plan(tasks: list[Task]) -> TaskPlan:
    return TaskPlan(complexity=Complexity.simple, tasks=tasks)


def _mk_task_result(tid: str, *, all_pass: bool) -> TaskCheckResult:
    return TaskCheckResult(
        task_id=tid,
        items=[TaskCheckItem(check="tests_green", passed=all_pass)],
    )


def _mk_key_diffs(tid: str, *, non_empty: bool = True) -> KeyDiffsFile:
    return KeyDiffsFile(
        task_id=tid,
        key_diffs=(
            [KeyDiffEntry(file="src/x.py", change="c", why="w", risk="low")] if non_empty else []
        ),
    )


class TestAllTasksGreen:
    def test_pass(self) -> None:
        plan = _mk_plan([_mk_task("T01"), _mk_task("T02")])
        task_results = {
            "T01": _mk_task_result("T01", all_pass=True),
            "T02": _mk_task_result("T02", all_pass=True),
        }
        kd = {"T01": _mk_key_diffs("T01"), "T02": _mk_key_diffs("T02")}
        result = check_wrap_up(plan, task_results, kd)
        items = [i for i in result.items if i.check == "all_tasks_tests_green"]
        assert items and items[0].passed

    def test_fail(self) -> None:
        plan = _mk_plan([_mk_task("T01"), _mk_task("T02")])
        task_results = {
            "T01": _mk_task_result("T01", all_pass=True),
            "T02": _mk_task_result("T02", all_pass=False),
        }
        kd = {"T01": _mk_key_diffs("T01"), "T02": _mk_key_diffs("T02")}
        result = check_wrap_up(plan, task_results, kd)
        items = [i for i in result.items if i.check == "all_tasks_tests_green"]
        assert items and not items[0].passed


class TestKeyDiffsMdReady:
    def test_pass(self) -> None:
        plan = _mk_plan([_mk_task("T01")])
        result = check_wrap_up(
            plan, {"T01": _mk_task_result("T01", all_pass=True)}, {"T01": _mk_key_diffs("T01")}
        )
        items = [i for i in result.items if i.check == "key_diffs_md_ready"]
        assert items and items[0].passed

    def test_fail_when_no_submissions(self) -> None:
        plan = _mk_plan([_mk_task("T01")])
        result = check_wrap_up(
            plan, {"T01": _mk_task_result("T01", all_pass=True)}, {"T01": None}
        )
        items = [i for i in result.items if i.check == "key_diffs_md_ready"]
        assert items and not items[0].passed


class TestHardGates:
    def test_hard_gate_pass(self) -> None:
        plan = _mk_plan([_mk_task("T01", risk=RiskLevel.high)])
        result = check_wrap_up(
            plan,
            {"T01": _mk_task_result("T01", all_pass=True)},
            {"T01": _mk_key_diffs("T01", non_empty=True)},
        )
        items = [i for i in result.items if i.check == "all_hard_gates_pass"]
        assert items and items[0].passed

    def test_hard_gate_fail_when_high_risk_missing(self) -> None:
        plan = _mk_plan([_mk_task("T01", risk=RiskLevel.high)])
        result = check_wrap_up(
            plan,
            {"T01": _mk_task_result("T01", all_pass=True)},
            {"T01": None},
        )
        items = [i for i in result.items if i.check == "all_hard_gates_pass"]
        assert items and not items[0].passed


class TestScopeConsistent:
    def test_pass(self) -> None:
        plan = _mk_plan([_mk_task("T01")])
        result = check_wrap_up(
            plan,
            {"T01": _mk_task_result("T01", all_pass=True)},
            {"T01": _mk_key_diffs("T01")},
            planned_scope_files=["src/T01/a.py"],
            actual_scope_files=["src/T01/a.py"],
        )
        items = [i for i in result.items if i.check == "scope_consistent"]
        assert items and items[0].passed

    def test_fail_on_bloat(self) -> None:
        plan = _mk_plan([_mk_task("T01")])
        planned = ["src/T01/a.py"]
        # 大量计划外文件
        actual = planned + [f"src/extra/{i}.py" for i in range(20)]
        result = check_wrap_up(
            plan,
            {"T01": _mk_task_result("T01", all_pass=True)},
            {"T01": _mk_key_diffs("T01")},
            planned_scope_files=planned,
            actual_scope_files=actual,
        )
        items = [i for i in result.items if i.check == "scope_consistent"]
        assert items and not items[0].passed


class TestIntegrationTests:
    def test_skipped_when_none(self) -> None:
        plan = _mk_plan([_mk_task("T01")])
        result = check_wrap_up(
            plan,
            {"T01": _mk_task_result("T01", all_pass=True)},
            {"T01": _mk_key_diffs("T01")},
            integration_results=None,
        )
        items = [i for i in result.items if i.check == "integration_tests_green"]
        assert items and items[0].passed
        assert "跳过" in items[0].detail

    def test_pass_when_all_green(self) -> None:
        plan = _mk_plan([_mk_task("T01")])
        result = check_wrap_up(
            plan,
            {"T01": _mk_task_result("T01", all_pass=True)},
            {"T01": _mk_key_diffs("T01")},
            integration_results={"ic1": True, "ic2": True},
        )
        items = [i for i in result.items if i.check == "integration_tests_green"]
        assert items and items[0].passed

    def test_fail_when_some_red(self) -> None:
        plan = _mk_plan([_mk_task("T01")])
        result = check_wrap_up(
            plan,
            {"T01": _mk_task_result("T01", all_pass=True)},
            {"T01": _mk_key_diffs("T01")},
            integration_results={"ic1": True, "ic2": False},
        )
        items = [i for i in result.items if i.check == "integration_tests_green"]
        assert items and not items[0].passed

def test_required_integration_fails_when_missing() -> None:
    plan = _mk_plan([_mk_task("T01")])
    result = check_wrap_up(
        plan,
        {"T01": _mk_task_result("T01", all_pass=True)},
        {"T01": _mk_key_diffs("T01")},
        integration_results=None,
        requires_integration=True,
    )
    items = [i for i in result.items if i.check == "integration_tests_green"]
    assert items and not items[0].passed
    assert "不可跳过" in items[0].detail
