"""§2.2 任务自检 (worker 完成单个 task 后的自核).

规范源: design §2.2 + §0.2 关键约定 (tests_green 用 S4 eval_result.tests_green, 不信 worker 自报).

四项全部客观可判定. 关键点: tests_green 用 S4 的 eval_result.tests_green
(worker 自报告的 tests_green 是 hallucination 最可能落点, §0.2).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from loop_engineering.checklists.checks_eval import TaskCheckEvalResult
from loop_engineering.scheduling.actual_writes import OOBDetection
from loop_engineering.schema.artifacts import TestResults
from loop_engineering.schema.task_plan import Task


@dataclass(frozen=True)
class TaskCheckItem:
    """单条任务自检结果."""

    check: str
    passed: bool
    detail: str = ""


@dataclass(frozen=True)
class TaskCheckResult:
    """单个 task 自检汇总."""

    task_id: str
    items: list[TaskCheckItem] = field(default_factory=list)

    @property
    def all_pass(self) -> bool:
        """全部通过 = 至少一项且全 pass."""
        return bool(self.items) and all(i.passed for i in self.items)


def check_task(
    task: Task,
    test_results: TestResults,
    eval_result: TaskCheckEvalResult,
    oob: OOBDetection | None = None,
    active_tasks: list[Task] | None = None,
    path_overlap_fn: Callable[[list[str], list[str]], bool] | None = None,
) -> TaskCheckResult:
    """跑 §2.2 四项任务自检.

    Args:
        task: 当前 task.
        test_results: worker 交回的 test-results.yaml (本模块不直接用其 tests_green).
        eval_result: S4 求值结果, tests_green 用它的 .tests_green 而非 worker 自报.
        oob: actual_writes 越界检测结果; None 表示 actual_writes 不可用 (单上下文兜底),
            diff_within_allowed_paths 项降级为软约束.
        active_tasks: 同期 active 的其它 task, 用于"不动其它 active task 写路径".
        path_overlap_fn: 路径重叠判定注入 (= S3.path_globs_overlap).

    Notes:
        test_results 参数保留以便扩展 / 调用方持有, 本模块不直接读它.
    """
    if path_overlap_fn is None:
        from loop_engineering.scheduling.path_overlap import path_globs_overlap

        path_overlap_fn = path_globs_overlap

    del test_results  # 本模块不直接用, 防止误读 worker 自报告 tests_green.

    items: list[TaskCheckItem] = []
    items.append(_check_tests_green(eval_result))
    items.append(_check_diff_within_allowed_paths(oob))
    items.append(_check_all_acceptance_refs_have_tests(task))
    items.append(_check_no_encroaching_other_active_paths(task, active_tasks, path_overlap_fn))

    return TaskCheckResult(task_id=task.id, items=items)


def _check_tests_green(eval_result: TaskCheckEvalResult) -> TaskCheckItem:
    """tests_green 用 S4 机械求值的 eval_result.tests_green (§0.2)."""
    ok = eval_result.tests_green
    return TaskCheckItem(
        check="tests_green",
        passed=ok,
        detail="" if ok else f"task {eval_result.task_id} 的 cases 求值未全绿",
    )


def _check_diff_within_allowed_paths(oob: OOBDetection | None) -> TaskCheckItem:
    """越界写检测. oob=None (actual_writes 不可用) → 软 pass with 降级说明."""
    if oob is None:
        return TaskCheckItem(
            check="diff_within_allowed_paths",
            passed=True,
            detail="actual_writes 不可用, 此项降级软约束",
        )
    if oob.is_oob:
        return TaskCheckItem(
            check="diff_within_allowed_paths",
            passed=False,
            detail=f"越界写: {oob.out_of_bounds}",
        )
    return TaskCheckItem(
        check="diff_within_allowed_paths",
        passed=True,
        detail=f"all writes in {oob.declared_paths}",
    )


def _check_all_acceptance_refs_have_tests(task: Task) -> TaskCheckItem:
    """task.acceptance_refs 非空且 task.tests 非空即 pass.

    严格"AC → test case"映射在 plan_check 已查, 此处只兜底确保 task 自身不空.
    """
    if not task.acceptance_refs:
        return TaskCheckItem(
            check="all_acceptance_refs_have_tests",
            passed=False,
            detail=f"task {task.id} 的 acceptance_refs 为空",
        )
    if not task.tests:
        return TaskCheckItem(
            check="all_acceptance_refs_have_tests",
            passed=False,
            detail=f"task {task.id} 无 test case",
        )
    return TaskCheckItem(
        check="all_acceptance_refs_have_tests",
        passed=True,
        detail=f"{len(task.tests)} case(s) 覆盖 {len(task.acceptance_refs)} AC",
    )


def _check_no_encroaching_other_active_paths(
    task: Task,
    active_tasks: list[Task] | None,
    path_overlap_fn: Callable[[list[str], list[str]], bool],
) -> TaskCheckItem:
    """task 没动到其它 active task 的 allowed_write_paths.

    判定: 本 task 的 allowed_write_paths 与其它 active task 的 allowed_write_paths
    不重叠. 注意此处不读 actual_writes, 只判声明路径冲突 (实际写入冲突在 §3.2 conflicts 算).
    active_tasks=None 时跳过 (软 pass).
    """
    if not active_tasks:
        return TaskCheckItem(
            check="no_encroaching_other_active_paths",
            passed=True,
            detail="无其它 active task (或未传入)",
        )

    encroached: list[str] = []
    for other in active_tasks:
        if other.id == task.id:
            continue
        if path_overlap_fn(task.allowed_write_paths, other.allowed_write_paths):
            encroached.append(other.id)

    if encroached:
        return TaskCheckItem(
            check="no_encroaching_other_active_paths",
            passed=False,
            detail=f"task {task.id} 与 active task {encroached} 的写路径重叠",
        )
    return TaskCheckItem(
        check="no_encroaching_other_active_paths",
        passed=True,
        detail=f"task {task.id} 与其它 active task 写路径不冲突",
    )
