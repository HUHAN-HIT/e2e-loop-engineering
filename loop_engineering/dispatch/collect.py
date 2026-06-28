"""worker 交回后的产物回收 + actual_writes 采集 + 任务自检串联 (design §3.4).

规范源: design §3.4 (actual_writes 采集时机) + §0.2 (不信 worker 自报 tests_green) +
§2.2 (任务自检).

关键: collect_outcome 在 worker 交回那一刻立即跑, coordinator 侧独立采集 actual_writes
(不经 worker 自报), 再喂给 checks 求值与任务自检. 不修改 task, 只产出 CollectedTaskResult.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ..checklists.checks_eval import TaskCheckEvalResult, eval_task
from ..checklists.task_check import TaskCheckResult, check_task
from ..scheduling.actual_writes import (
    ActualWritesCollection,
    OOBDetection,
    collect_actual_writes,
    detect_out_of_bounds,
    take_fs_snapshot,
)
from ..scheduling.path_overlap import path_globs_overlap
from ..schema.run_state import RunCapabilities
from ..schema.task_plan import Task
from .packet import WorkerPacket
from .worker_runner import WorkerOutcome

__all__ = ["CollectedTaskResult", "collect_outcome"]


@dataclass(frozen=True)
class CollectedTaskResult:
    """一次 task 完成后的全量回收结果.

    含 actual_writes 采集 + 越界检测 + S4 checks 求值 + S7 任务自检, 以及回查用的 packet.
    task.status 的修改由 coordinator 决定, 本结果只描述事实.
    """

    task_id: str
    outcome: WorkerOutcome
    actual_writes: ActualWritesCollection
    oob: OOBDetection
    eval_result: TaskCheckEvalResult
    task_check_result: TaskCheckResult
    packet: WorkerPacket


def collect_outcome(
    task: Task,
    outcome: WorkerOutcome,
    packet: WorkerPacket,
    capabilities: RunCapabilities,
    *,
    base_ref: str | None = None,
    before_snapshot: dict[str, float] | None = None,
    earlier_task_writes: dict[str, list[str]] | None = None,
) -> CollectedTaskResult:
    """串联 §3.4 actual_writes 采集 + §3.1 checks 求值 + §2.2 任务自检.

    Args:
        task: 当前 task (只读, 不修改).
        outcome: worker 交回的 outcome.
        packet: 派发时的 packet (含 workdir / allowed_write_paths 等回查).
        capabilities: 宿主能力 (决定 actual_writes 走哪一层采集).
        base_ref: git diff 基线 ref (capabilities.git_diff=True 时用).
        before_snapshot: 派出前的 fs snapshot (capabilities.fs_snapshot=True 时用).
        earlier_task_writes: 跨 task 路径归属表 (task_id → 实际写入列表),
            用于越界检测第 2 层 (跨 task 共享路径归最早写入者).

    Returns:
        CollectedTaskResult. 不修改 task.

    Notes:
        - 失败 / plan_amendment outcome 也走本函数, 但 actual_writes / eval_result 会
          以空集 / 全 fail 形态返回 (caller 据 outcome.status 决定后续).
        - actual_writes 采集的 after_snapshot 在本函数内即时取 (worker 交回那一刻).
        - eval_result 用 outcome.test_results (若 None, 用一个全空的 TestResults 兜底,
          eval_task 会自然产出全 fail 的 case_results).
    """
    # 1. actual_writes 采集 (§3.4 三层优先级)
    after_snapshot: dict[str, float] | None = None
    if capabilities.fs_snapshot and before_snapshot is not None:
        after_snapshot = take_fs_snapshot(packet.workdir)

    # outcome=failed/plan_amendment 时 test_results 多半为 None, 用空集让 eval_task 自然全 fail.
    test_results = outcome.test_results
    if test_results is None:
        # 延迟 import 避免循环依赖 (artifacts → 无依赖, 实际上直接 import 也行)
        from ..schema.artifacts import TestResults, TestCaseResult
        test_results = TestResults(tests_green=False, cases=[])

    actual_writes = collect_actual_writes(
        packet.workdir,
        task.id,
        capabilities,
        base_ref=base_ref,
        before_snapshot=before_snapshot,
        after_snapshot=after_snapshot,
        # 没有独立采集能力时, 把 worker summary 里的"声称写入"作为 self_report 兜底;
        # 真实场景下 summary_text 是自由文本, 这里简单留空, 让 source=worker_self_report 退化为空集.
        worker_self_report=[],
    )

    # 2. 越界检测 (§3.4 两层)
    oob = detect_out_of_bounds(
        task,
        actual_writes,
        path_overlap_fn=path_globs_overlap,
        earlier_task_writes=earlier_task_writes,
    )

    # 3. S4 checks 求值
    eval_result = eval_task(test_results, task.tests, task.id)

    # 4. S7 任务自检 (eval_result.tests_green 不信 worker 自报, §0.2)
    task_check_result = check_task(
        task,
        test_results,
        eval_result,
        oob=oob,
        active_tasks=None,  # 跨 task 路径冲突由 §3.2 conflicts 在调度期挡, 这里只看本 task
        path_overlap_fn=path_globs_overlap,
    )

    return CollectedTaskResult(
        task_id=task.id,
        outcome=outcome,
        actual_writes=actual_writes,
        oob=oob,
        eval_result=eval_result,
        task_check_result=task_check_result,
        packet=packet,
    )
