"""§2.3 收口自检.

规范源: design §2.3 + §11.3 (多服务集成自检).

五项客观检查:
1. all_tasks_tests_green —— 全部 task 任务自检通过
2. key_diffs_md_ready —— 关键改动清单齐备
3. scope_consistent —— 计划/实际 scope 一致 (无异常膨胀)
4. all_hard_gates_pass —— risk:high/exclusive task 的 key-diffs 硬 gate 通过
5. integration_tests_green —— 多服务时所有契约集成用例绿 (单服务跳过)
"""
from __future__ import annotations

from dataclasses import dataclass, field

from loop_engineering.checklists.key_diffs_gate import (
    GateStatus,
    all_hard_gates_pass,
    validate_many,
)
from loop_engineering.checklists.task_check import TaskCheckResult
from loop_engineering.schema.artifacts import KeyDiffsFile
from loop_engineering.schema.task_plan import TaskPlan


@dataclass(frozen=True)
class WrapUpCheckItem:
    """单条收口自检结果."""

    check: str
    passed: bool
    detail: str = ""


@dataclass(frozen=True)
class WrapUpCheckResult:
    """收口自检汇总."""

    items: list[WrapUpCheckItem] = field(default_factory=list)

    @property
    def all_pass(self) -> bool:
        return bool(self.items) and all(i.passed for i in self.items)


def check_wrap_up(
    plan: TaskPlan,
    task_results: dict[str, TaskCheckResult],
    key_diffs_by_task: dict[str, KeyDiffsFile | None],
    *,
    integration_results: dict[str, bool] | None = None,
    planned_scope_files: list[str] | None = None,
    actual_scope_files: list[str] | None = None,
    requires_integration: bool = False,
) -> WrapUpCheckResult:
    """跑 §2.3 全部.

    Args:
        plan: 计划.
        task_results: 每 task_id -> 任务自检结果. 缺失的 task 视为未通过.
        key_diffs_by_task: 每 task_id -> key-diffs.yaml (None = 未提交或解析失败).
        integration_results: 多服务时 case_id -> green? None 跳过该项.
        planned_scope_files: 计划期声明的预期文件清单.
        actual_scope_files: 收口时的实际改动文件清单.
        requires_integration: 多服务/契约 run 为 True; 缺 integration_results 时不得软跳过.
    """
    items: list[WrapUpCheckItem] = []
    items.append(_check_all_tasks_tests_green(plan, task_results))
    items.append(_check_key_diffs_md_ready(plan, key_diffs_by_task))
    items.append(_check_scope_consistent(planned_scope_files, actual_scope_files))
    items.append(_check_all_hard_gates_pass(plan, key_diffs_by_task))
    items.append(_check_integration_tests_green(integration_results, required=requires_integration))
    return WrapUpCheckResult(items=items)


def _check_all_tasks_tests_green(
    plan: TaskPlan, task_results: dict[str, TaskCheckResult]
) -> WrapUpCheckItem:
    """全部 task 任务自检通过."""
    missing: list[str] = []
    failed: list[str] = []
    for t in plan.tasks:
        r = task_results.get(t.id)
        if r is None:
            missing.append(t.id)
            continue
        if not r.all_pass:
            failed.append(t.id)
    if missing or failed:
        detail_parts: list[str] = []
        if missing:
            detail_parts.append(f"缺自检结果: {missing}")
        if failed:
            detail_parts.append(f"自检未全绿: {failed}")
        return WrapUpCheckItem(
            check="all_tasks_tests_green",
            passed=False,
            detail="; ".join(detail_parts),
        )
    return WrapUpCheckItem(
        check="all_tasks_tests_green",
        passed=True,
        detail=f"{len(plan.tasks)} task 全部自检通过",
    )


def _check_key_diffs_md_ready(
    plan: TaskPlan, key_diffs_by_task: dict[str, KeyDiffsFile | None]
) -> WrapUpCheckItem:
    """每个有关键改动的 task 已产出 key-diffs.yaml.

    客观判: 至少有 task 提交过非空 key-diffs 即视为"清单齐备". 严格硬 gate 在
    all_hard_gates_pass 项查.
    """
    non_empty_submitters: list[str] = []
    for t in plan.tasks:
        kd = key_diffs_by_task.get(t.id)
        if kd is not None and kd.is_meaningful():
            non_empty_submitters.append(t.id)
    if not non_empty_submitters:
        return WrapUpCheckItem(
            check="key_diffs_md_ready",
            passed=False,
            detail="无任何 task 提交非空 key-diffs.yaml",
        )
    return WrapUpCheckItem(
        check="key_diffs_md_ready",
        passed=True,
        detail=f"{len(non_empty_submitters)} task 提交了 key-diffs",
    )


def _check_scope_consistent(
    planned: list[str] | None, actual: list[str] | None
) -> WrapUpCheckItem:
    """scope 与计划一致 (无计划外大范围改动).

    客观判: actual 是 planned 的子集 (允许计划内文件少于预期), 或新增文件不超过
    planned 数量的 50% (允许少量计划外文件如新加的小工具).
    两者任一为 None 时软 pass.
    """
    if planned is None or actual is None:
        return WrapUpCheckItem(
            check="scope_consistent",
            passed=True,
            detail="planned/actual scope 未提供, 跳过",
        )
    planned_set = set(planned)
    actual_set = set(actual)
    extras = actual_set - planned_set
    if not extras:
        return WrapUpCheckItem(
            check="scope_consistent",
            passed=True,
            detail=f"actual ({len(actual_set)}) 全在 planned ({len(planned_set)}) 范围内",
        )
    # 允许少量膨胀: extras <= planned 的 50%, 且绝对值 <= 5
    allow_ratio = max(1, len(planned_set) // 2)
    allow_abs = 5
    if len(extras) <= allow_ratio and len(extras) <= allow_abs:
        return WrapUpCheckItem(
            check="scope_consistent",
            passed=True,
            detail=f"少量计划外文件 {sorted(extras)} (允许范围内)",
        )
    return WrapUpCheckItem(
        check="scope_consistent",
        passed=False,
        detail=f"实际改动异常膨胀: planned={len(planned_set)}, 实际新增 {len(extras)} 个计划外文件 {sorted(extras)[:5]}...",
    )


def _check_all_hard_gates_pass(
    plan: TaskPlan, key_diffs_by_task: dict[str, KeyDiffsFile | None]
) -> WrapUpCheckItem:
    """risk:high / exclusive task 的 key-diffs 硬 gate 通过 (复用 key_diffs_gate)."""
    results = validate_many(list(plan.tasks), key_diffs_by_task)
    if all_hard_gates_pass(results):
        failed = [r for r in results if r.status == GateStatus.FAIL]
        # all_hard_gates_pass 仅判 FAIL, 通过即无 FAIL
        return WrapUpCheckItem(
            check="all_hard_gates_pass",
            passed=True,
            detail=f"无硬 gate FAIL (共 {len(results)} 项校验, {len(failed)} 项 FAIL)",
        )
    fails = [r for r in results if r.status == GateStatus.FAIL]
    return WrapUpCheckItem(
        check="all_hard_gates_pass",
        passed=False,
        detail="; ".join(f"{r.task_id}: {r.reason}" for r in fails),
    )


def _check_integration_tests_green(
    integration_results: dict[str, bool] | None,
    *,
    required: bool = False,
) -> WrapUpCheckItem:
    """多服务: 所有契约集成用例绿. 单服务可跳过."""
    if integration_results is None:
        if required:
            return WrapUpCheckItem(
                check="integration_tests_green",
                passed=False,
                detail="多服务/契约 run 缺 integration_results, 不可跳过",
            )
        return WrapUpCheckItem(
            check="integration_tests_green",
            passed=True,
            detail="单服务 run, 跳过",
        )
    if not integration_results:
        return WrapUpCheckItem(
            check="integration_tests_green",
            passed=False,
            detail="多服务 run 但无集成用例结果",
        )
    failed_cases = [cid for cid, ok in integration_results.items() if not ok]
    if failed_cases:
        return WrapUpCheckItem(
            check="integration_tests_green",
            passed=False,
            detail=f"集成用例未全绿: {failed_cases}",
        )
    return WrapUpCheckItem(
        check="integration_tests_green",
        passed=True,
        detail=f"{len(integration_results)} 个集成用例全绿",
    )
