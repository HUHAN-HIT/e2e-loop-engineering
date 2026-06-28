"""tests for loop_engineering.amendment.rollback."""
from __future__ import annotations

from loop_engineering.amendment.rollback import (
    RollbackPlan,
    apply_rollback,
    compute_rollback,
    expand_acceptance_refs,
    summarize,
)
from loop_engineering.amendment.ac_index import build_ac_to_tasks, build_task_to_acs
from loop_engineering.schema.artifacts import PlanAmendmentNeeded
from loop_engineering.schema.task_plan import Task, TaskPlan, TaskStatus


# ---------- helpers ----------

def _task(
    tid: str,
    acs: list[str],
    *,
    status: TaskStatus = TaskStatus.pending,
    attempt: int = 0,
) -> Task:
    return Task(
        id=tid,
        title=f"task {tid}",
        allowed_write_paths=[f"src/{tid}/**"],
        acceptance_refs=list(acs),
        status=status,
        attempt=attempt,
    )


def _plan(*tasks: Task) -> TaskPlan:
    return TaskPlan(complexity="medium", tasks=list(tasks))


def _amendment(*acs: str, reason: str = "用例不可执行") -> PlanAmendmentNeeded:
    return PlanAmendmentNeeded(reason=reason, touched_acceptance_refs=list(acs))


# ---------- 基本回滚 ----------

def test_complete_task_intersecting_downgraded() -> None:
    """complete + 相交 → downgrade_to_pending."""
    plan = _plan(_task("T01", ["AC-001"], status=TaskStatus.complete))
    rb = compute_rollback(plan, _amendment("AC-001"))
    assert rb.downgrade_to_pending == ["T01"]
    assert rb.recall_to_pending == []
    assert rb.untouched == []


def test_running_task_intersecting_recalled() -> None:
    """running + 相交 → recall_to_pending."""
    plan = _plan(_task("T02", ["AC-001"], status=TaskStatus.running))
    rb = compute_rollback(plan, _amendment("AC-001"))
    assert rb.recall_to_pending == ["T02"]
    assert rb.downgrade_to_pending == []
    assert rb.untouched == []


def test_pending_task_intersecting_untouched() -> None:
    """pending + 相交 → untouched (它本来就在等)."""
    plan = _plan(_task("T03", ["AC-001"], status=TaskStatus.pending))
    rb = compute_rollback(plan, _amendment("AC-001"))
    assert rb.untouched == ["T03"]
    assert rb.downgrade_to_pending == []
    assert rb.recall_to_pending == []


def test_blocked_task_intersecting_untouched() -> None:
    """blocked + 相交 → untouched (永不选中, 无需操作)."""
    plan = _plan(_task("T04", ["AC-001"], status=TaskStatus.blocked))
    rb = compute_rollback(plan, _amendment("AC-001"))
    assert rb.untouched == ["T04"]
    assert rb.downgrade_to_pending == []
    assert rb.recall_to_pending == []


def test_non_intersecting_task_untouched() -> None:
    """不相交 task → untouched (无论状态)."""
    plan = _plan(
        _task("T05a", ["AC-999"], status=TaskStatus.complete),
        _task("T05b", ["AC-999"], status=TaskStatus.running),
        _task("T05c", [], status=TaskStatus.complete),  # 无 AC 锚点, 必不相交
    )
    rb = compute_rollback(plan, _amendment("AC-001"))
    assert set(rb.untouched) == {"T05a", "T05b", "T05c"}
    assert rb.downgrade_to_pending == []
    assert rb.recall_to_pending == []


# ---------- 保守扩围 ----------

def test_expansion_to_neighbor_acs_in_same_task() -> None:
    """T01 complete + [AC-001,AC-002], amendment touches AC-001 → 扩围 {AC-001,AC-002}.

    T01 仍被 downgrade (它的 AC-002 也被纳入扩围).
    """
    plan = _plan(_task("T01", ["AC-001", "AC-002"], status=TaskStatus.complete))
    rb = compute_rollback(plan, _amendment("AC-001"))
    assert set(rb.expanded_acceptance_refs) == {"AC-001", "AC-002"}
    assert set(rb.touched_acceptance_refs) == {"AC-001"}
    assert rb.downgrade_to_pending == ["T01"]


def test_expansion_propagates_to_other_task_via_neighbor_ac() -> None:
    """T01[AC-001,AC-002] + T02[AC-002], amendment touches AC-001
    → 扩围 {AC-001, AC-002}, T02 也被纳入回滚 (因为 AC-002 是 T01 邻居 + T02 也消费它).
    """
    plan = _plan(
        _task("T01", ["AC-001", "AC-002"], status=TaskStatus.complete),
        _task("T02", ["AC-002"], status=TaskStatus.complete),
    )
    ac_idx = build_ac_to_tasks(plan)
    task_idx = build_task_to_acs(plan)
    expanded = expand_acceptance_refs(plan, ac_idx, task_idx, ["AC-001"])
    assert set(expanded) == {"AC-001", "AC-002"}
    # 端到端: 两个 task 都应被 downgrade
    rb = compute_rollback(plan, _amendment("AC-001"))
    assert set(rb.downgrade_to_pending) == {"T01", "T02"}


def test_expansion_does_not_cross_unrelated_tasks() -> None:
    """T01[AC-001] + T02[AC-999], amendment touches AC-001 → 扩围 {AC-001}, T02 不受影响."""
    plan = _plan(
        _task("T01", ["AC-001"], status=TaskStatus.complete),
        _task("T02", ["AC-999"], status=TaskStatus.complete),
    )
    ac_idx = build_ac_to_tasks(plan)
    task_idx = build_task_to_acs(plan)
    expanded = expand_acceptance_refs(plan, ac_idx, task_idx, ["AC-001"])
    assert set(expanded) == {"AC-001"}
    rb = compute_rollback(plan, _amendment("AC-001"))
    assert rb.downgrade_to_pending == ["T01"]
    assert "T02" in rb.untouched


# ---------- apply 语义 ----------

def test_apply_returns_new_instance() -> None:
    """apply 不改原 plan."""
    plan = _plan(_task("T01", ["AC-001"], status=TaskStatus.complete))
    rb = compute_rollback(plan, _amendment("AC-001"))
    new_plan = apply_rollback(plan, rb)
    assert new_plan is not plan
    # 原 plan 中 T01 仍是 complete
    assert plan.tasks[0].status == TaskStatus.complete
    # 新 plan 中 T01 已是 pending
    assert new_plan.tasks[0].status == TaskStatus.pending


def test_apply_downgrade_keeps_attempt() -> None:
    """downgrade 不重置 attempt (由 coordinator 在重派时决定)."""
    plan = _plan(
        _task("T01", ["AC-001"], status=TaskStatus.complete, attempt=3),
    )
    rb = compute_rollback(plan, _amendment("AC-001"))
    new_plan = apply_rollback(plan, rb)
    assert new_plan.tasks[0].status == TaskStatus.pending
    assert new_plan.tasks[0].attempt == 3  # 保留


def test_apply_recall_keeps_attempt() -> None:
    """recall 也不重置 attempt (本次派发已作废, 但 attempt 计数保留)."""
    plan = _plan(
        _task("T02", ["AC-001"], status=TaskStatus.running, attempt=2),
    )
    rb = compute_rollback(plan, _amendment("AC-001"))
    new_plan = apply_rollback(plan, rb)
    assert new_plan.tasks[0].status == TaskStatus.pending
    assert new_plan.tasks[0].attempt == 2


def test_apply_untouched_preserved() -> None:
    """untouched task 的 status / attempt / 其他字段原样保留."""
    plan = _plan(
        _task(
            "T01",
            ["AC-999"],
            status=TaskStatus.complete,
            attempt=5,
        ),
        _task("T02", ["AC-001"], status=TaskStatus.complete, attempt=1),
    )
    rb = compute_rollback(plan, _amendment("AC-001"))
    new_plan = apply_rollback(plan, rb)
    # T01 untouched: 全字段保留
    t01_old = plan.tasks[0]
    t01_new = new_plan.tasks[0]
    assert t01_new.status == t01_old.status == TaskStatus.complete
    assert t01_new.attempt == t01_old.attempt == 5
    assert t01_new.allowed_write_paths == t01_old.allowed_write_paths
    assert t01_new.acceptance_refs == t01_old.acceptance_refs
    # T02 downgrade
    assert new_plan.tasks[1].status == TaskStatus.pending
    assert new_plan.tasks[1].attempt == 1


# ---------- changes_semantics 字段 ----------

def test_changes_semantics_flag_passthrough() -> None:
    """compute_rollback(..., changes_semantics=True) → RollbackPlan.changes_semantics=True."""
    plan = _plan(_task("T01", ["AC-001"]))
    rb = compute_rollback(plan, _amendment("AC-001"), changes_semantics=True)
    assert rb.changes_semantics is True


def test_changes_semantics_default_false() -> None:
    """默认 changes_semantics=False."""
    plan = _plan(_task("T01", ["AC-001"]))
    rb = compute_rollback(plan, _amendment("AC-001"))
    assert rb.changes_semantics is False


# ---------- 端到端 ----------

def test_end_to_end_amendment_workflow() -> None:
    """4 task plan, amendment touch 一条 AC, 验证完整 RollbackPlan + apply 后状态分布.

    场景:
        T01 [AC-001, AC-002] complete, attempt=1   ← amendment touches AC-001
        T02 [AC-002]        running,  attempt=2   ← 邻居 AC-002 被扩围进来
        T03 [AC-003]        pending,  attempt=0   ← 不相交
        T04 [AC-001]        complete, attempt=3   ← 直接相交
    amendment touches AC-001 → 扩围 {AC-001, AC-002} (因为 T01 邻居)
    期望:
        downgrade: T01, T04
        recall:    T02
        untouched: T03
    """
    plan = _plan(
        _task("T01", ["AC-001", "AC-002"], status=TaskStatus.complete, attempt=1),
        _task("T02", ["AC-002"], status=TaskStatus.running, attempt=2),
        _task("T03", ["AC-003"], status=TaskStatus.pending, attempt=0),
        _task("T04", ["AC-001"], status=TaskStatus.complete, attempt=3),
    )
    rb = compute_rollback(plan, _amendment("AC-001"), changes_semantics=False)

    # RollbackPlan 字段
    assert set(rb.touched_acceptance_refs) == {"AC-001"}
    assert set(rb.expanded_acceptance_refs) == {"AC-001", "AC-002"}
    assert set(rb.downgrade_to_pending) == {"T01", "T04"}
    assert set(rb.recall_to_pending) == {"T02"}
    assert set(rb.untouched) == {"T03"}
    assert rb.changes_semantics is False

    # apply 后状态
    new_plan = apply_rollback(plan, rb)
    by_id = {t.id: t for t in new_plan.tasks}
    assert by_id["T01"].status == TaskStatus.pending
    assert by_id["T01"].attempt == 1  # 保留
    assert by_id["T02"].status == TaskStatus.pending
    assert by_id["T02"].attempt == 2  # 保留
    assert by_id["T03"].status == TaskStatus.pending  # 未变
    assert by_id["T03"].attempt == 0
    assert by_id["T04"].status == TaskStatus.pending
    assert by_id["T04"].attempt == 3  # 保留

    # summarize 不抛错且包含关键信息
    s = summarize(rb)
    assert "T01" in s and "T04" in s and "T02" in s
    assert "AC-001" in s and "AC-002" in s


def test_summarize_handles_empty_lists() -> None:
    """summarize 在所有列表为空时不抛错 (理论上不会发生, 但要稳健)."""
    rb = RollbackPlan(
        touched_acceptance_refs=[],
        expanded_acceptance_refs=[],
        downgrade_to_pending=[],
        recall_to_pending=[],
        untouched=[],
        changes_semantics=False,
    )
    s = summarize(rb)
    assert "无" in s  # _fmt 空列表输出 "(无)"
