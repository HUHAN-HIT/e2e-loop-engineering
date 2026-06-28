"""§2.2 任务自检测试 (design §2.2 + §0.2 tests_green 用 eval_result)."""
from __future__ import annotations

from loop_engineering.checklists.checks_eval import (
    CaseEvalResult,
    CheckEvalResult,
    Check,
    Op,
    TaskCheckEvalResult,
)
from loop_engineering.checklists.task_check import check_task
from loop_engineering.scheduling.actual_writes import ActualWritesCollection, OOBDetection
from loop_engineering.scheduling.path_overlap import path_globs_overlap
from loop_engineering.schema.artifacts import TestCaseResult, TestResults
from loop_engineering.schema.task_plan import Task, TestCase


def _mk_eval_result(task_id: str, *, green: bool) -> TaskCheckEvalResult:
    if green:
        case = CaseEvalResult(
            case_id="c1",
            check_results=[
                CheckEvalResult(Check(raw="passed == true", lhs="passed", op=Op.EQ, rhs=True), True)
            ],
        )
    else:
        case = CaseEvalResult(
            case_id="c1",
            check_results=[
                CheckEvalResult(
                    Check(raw="passed == true", lhs="passed", op=Op.EQ, rhs=True),
                    False,
                    error="mismatch",
                )
            ],
        )
    return TaskCheckEvalResult(task_id=task_id, case_results=[case])


def _mk_test_results(*, green: bool) -> TestResults:
    return TestResults(
        tests_green=green,
        cases=[TestCaseResult(id="c1", passed=green)],
    )


def _mk_task(
    tid: str = "T01",
    *,
    refs: list[str] | None = None,
    paths: list[str] | None = None,
    tests: int = 1,
) -> Task:
    return Task(
        id=tid,
        title=tid,
        allowed_write_paths=paths or ["src/T01/**"],
        acceptance_refs=refs or ["AC-1"],
        tests=[TestCase(id=f"c{i}", scenario="s", checks=["passed == true"]) for i in range(tests)],
    )


class TestTestsGreen:
    def test_green_passes(self) -> None:
        t = _mk_task()
        result = check_task(t, _mk_test_results(green=True), _mk_eval_result("T01", green=True))
        items = [i for i in result.items if i.check == "tests_green"]
        assert items and items[0].passed

    def test_red_fails(self) -> None:
        t = _mk_task()
        result = check_task(t, _mk_test_results(green=True), _mk_eval_result("T01", green=False))
        items = [i for i in result.items if i.check == "tests_green"]
        assert items and not items[0].passed

    def test_uses_eval_result_not_worker_tests_green(self) -> None:
        # 关键: worker 自报 tests_green=True, 但 eval_result.tests_green=False -> 项 fail
        t = _mk_task()
        result = check_task(t, _mk_test_results(green=True), _mk_eval_result("T01", green=False))
        items = [i for i in result.items if i.check == "tests_green"]
        assert items and not items[0].passed


class TestOOB:
    def test_oob_pass(self) -> None:
        t = _mk_task(paths=["src/T01/**"])
        oob = OOBDetection(
            task_id="T01",
            declared_paths=["src/T01/**"],
            actual_writes=["src/T01/a.py"],
            out_of_bounds=[],
            is_oob=False,
        )
        result = check_task(
            t,
            _mk_test_results(green=True),
            _mk_eval_result("T01", green=True),
            oob=oob,
        )
        items = [i for i in result.items if i.check == "diff_within_allowed_paths"]
        assert items and items[0].passed

    def test_oob_fails_when_extra_path(self) -> None:
        t = _mk_task(paths=["src/T01/**"])
        oob = OOBDetection(
            task_id="T01",
            declared_paths=["src/T01/**"],
            actual_writes=["src/T01/a.py", "src/OTHER/b.py"],
            out_of_bounds=["src/OTHER/b.py"],
            is_oob=True,
        )
        result = check_task(
            t,
            _mk_test_results(green=True),
            _mk_eval_result("T01", green=True),
            oob=oob,
        )
        items = [i for i in result.items if i.check == "diff_within_allowed_paths"]
        assert items and not items[0].passed

    def test_oob_soft_when_unavailable(self) -> None:
        # oob=None -> soft pass with detail
        t = _mk_task()
        result = check_task(
            t,
            _mk_test_results(green=True),
            _mk_eval_result("T01", green=True),
            oob=None,
        )
        items = [i for i in result.items if i.check == "diff_within_allowed_paths"]
        assert items and items[0].passed
        assert "软约束" in items[0].detail


class TestAcceptanceRefs:
    def test_refs_have_tests_pass(self) -> None:
        t = _mk_task(refs=["AC-1"], tests=1)
        result = check_task(
            t, _mk_test_results(green=True), _mk_eval_result("T01", green=True)
        )
        items = [i for i in result.items if i.check == "all_acceptance_refs_have_tests"]
        assert items and items[0].passed

    def test_refs_have_tests_fail_when_no_tests(self) -> None:
        t = _mk_task(refs=["AC-1"], tests=0)
        result = check_task(
            t, _mk_test_results(green=True), _mk_eval_result("T01", green=True)
        )
        items = [i for i in result.items if i.check == "all_acceptance_refs_have_tests"]
        assert items and not items[0].passed


class TestNoEncroachingActivePaths:
    def test_no_active_tasks_pass(self) -> None:
        t = _mk_task()
        result = check_task(
            t,
            _mk_test_results(green=True),
            _mk_eval_result("T01", green=True),
            active_tasks=None,
            path_overlap_fn=path_globs_overlap,
        )
        items = [i for i in result.items if i.check == "no_encroaching_other_active_paths"]
        assert items and items[0].passed

    def test_encroaching_other_active_fails(self) -> None:
        t = _mk_task(paths=["src/shared/**"])
        other = _mk_task("T02", paths=["src/shared/**"])
        result = check_task(
            t,
            _mk_test_results(green=True),
            _mk_eval_result("T01", green=True),
            active_tasks=[other],
            path_overlap_fn=path_globs_overlap,
        )
        items = [i for i in result.items if i.check == "no_encroaching_other_active_paths"]
        assert items and not items[0].passed

def test_default_path_overlap_detects_active_conflict() -> None:
    t = _mk_task(paths=["src/shared/**"])
    other = _mk_task("T02", paths=["src/shared/**"])
    result = check_task(
        t,
        _mk_test_results(green=True),
        _mk_eval_result("T01", green=True),
        active_tasks=[other],
    )
    items = [i for i in result.items if i.check == "no_encroaching_other_active_paths"]
    assert items and not items[0].passed
