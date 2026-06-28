"""集成 dry-run 测试 (端到端验证 simple 档闭环, 用 RecordingWorkerRunner, 不打真实 LLM).

规范源: design §1 主流程 + §8/§8.1 (完成/中止定义) + §3.6 (plan-amendment) + §2.3 (硬 gate) +
§3.3 (watchdog) + §5 (trust_mode).

6 个端到端测试:
1. test_end_to_end_simple_run —— CREATED→PLANNING→IMPLEMENTING→WRAPPING_UP→COMPLETE
2. test_abort_during_planning —— abort → ABORTED, run-state.json 含 aborted_at/reason
3. test_plan_amendment_during_implementing —— worker 返回 plan_amendment → 回滚 + 回 PLANNING
4. test_hard_gate_task_missing_key_diffs_blocks_complete —— risk:high 缺 key-diffs → 收口自检 fail
5. test_watchdog_recycle_after_timeout —— worker 超时 → recycle, attempt+1
6. test_trust_mode_refuses_unattended —— switch_trust_mode → TrustModeSwitchRefused
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from loop_engineering.dispatch.worker_runner import (
    RecordingWorkerRunner,
    WorkerOutcome,
)
from loop_engineering.runtime.coordinator import Coordinator
from loop_engineering.runtime.directory import (
    init_run_dir,
    read_run_state,
    write_run_state,
)
from loop_engineering.schema.artifacts import (
    KeyDiffEntry,
    KeyDiffsFile,
    PlanAmendmentNeeded,
    TestCaseResult,
    TestResults,
)
from loop_engineering.schema.run_state import (
    HumanPending,
    Phase,
    RunState,
    TrustMode,
)
from loop_engineering.schema.task_plan import (
    RiskLevel,
    Task,
    TaskPlan,
    TestCase,
)
from loop_engineering.trust_mode.gate import (
    TrustModeSwitchRefused,
    switch_trust_mode,
)


COMPLEXITY_SIMPLE = "simple"


def _make_run_dir(tmp_path: Path, complexity: str = COMPLEXITY_SIMPLE) -> Path:
    """建一个 run_dir + 写 CREATED 状态. 用作所有测试的起点."""
    runs_root = tmp_path / "runs"
    runs_root.mkdir()
    run_id = "20260627-001"
    run_dir = init_run_dir(runs_root, run_id, "test requirement")
    state = RunState(run_id=run_id, complexity=complexity, phase=Phase.CREATED)
    write_run_state(run_dir, state)
    return run_dir


def _simple_plan(*, risk_high: bool = False, with_tests: bool = True) -> TaskPlan:
    """构造 minimal plan: 1 task, 1 AC, 1 happy-path test.

    risk_high=True 时把 task.risk 设成 high (触发 key-diffs 硬 gate).
    """
    test_cases = [
        TestCase(
            id="t1_happy",
            scenario="happy path",
            checks=["passed == true"],
        )
    ] if with_tests else []
    task = Task(
        id="T01",
        title="simple task",
        allowed_write_paths=["src/**"],
        acceptance_refs=["AC-001"],
        depends_on=[],
        risk=RiskLevel.high if risk_high else RiskLevel.normal,
        tests=test_cases,
    )
    return TaskPlan(complexity=COMPLEXITY_SIMPLE, tasks=[task])


def _completed_outcome(*, with_key_diffs: bool = False, task_id: str = "T01") -> WorkerOutcome:
    """构造一个 completed outcome (tests_green=True, 1 个 passed case).

    with_key_diffs=True 时附带非空 key-diffs.yaml.
    """
    test_results = TestResults(
        tests_green=True,
        cases=[TestCaseResult(id="t1_happy", passed=True)],
    )
    key_diffs = None
    if with_key_diffs:
        key_diffs = KeyDiffsFile(
            task_id=task_id,
            key_diffs=[
                KeyDiffEntry(
                    file="src/x.py",
                    change="add x",
                    why="for AC-001",
                    risk="low",
                )
            ],
        )
    return WorkerOutcome(
        status="completed",
        test_results=test_results,
        summary_text="done",
        key_diffs_file=key_diffs,
    )


# ---------------------------------------------------------------------------
# 1. 端到端 simple run
# ---------------------------------------------------------------------------


def test_end_to_end_simple_run(tmp_path: Path) -> None:
    """CREATED→PLANNING→IMPLEMENTING→WRAPPING_UP→COMPLETE 闭环 (RecordingWorkerRunner)."""
    run_dir = _make_run_dir(tmp_path)

    # 预置 worker outcome: completed, tests_green, 带非空 key-diffs (满足 key-diffs gate)
    runner = RecordingWorkerRunner([_completed_outcome(with_key_diffs=True)])
    coord = Coordinator(run_dir, runner)

    # 1. CREATED → PLANNING
    coord.start_planning()
    assert coord.state.phase == Phase.PLANNING

    # 2. 提交 plan + signoff
    plan = _simple_plan()
    coord.submit_plan(plan)
    assert coord.state.human_pending == HumanPending.plan_signoff
    coord.signoff_plan(accepted=True)
    assert coord.state.phase == Phase.IMPLEMENTING
    assert coord.state.human_pending is None

    # 3. 跑 tick 循环
    coord.run_until_human_or_terminal(max_ticks=10)

    # task 应已 complete, phase 应进 WRAPPING_UP (auto submit_wrap_up)
    assert coord.plan is not None
    assert coord.plan.tasks[0].status == "complete"
    assert coord.state.phase == Phase.WRAPPING_UP
    assert coord.state.human_pending == HumanPending.wrap_up_signoff

    # 4. 收口自检通过 → 等人 signoff
    result = (run_dir / "wrap-up" / "check-result.json").read_text(encoding="utf-8")
    assert "all_tasks_tests_green" in result

    # 5. signoff_wrap_up → COMPLETE
    coord.signoff_wrap_up(accepted=True)
    assert coord.state.phase == Phase.COMPLETE

    # 6. run-state.json 含 phase=COMPLETE
    persisted = read_run_state(run_dir)
    assert persisted.phase == Phase.COMPLETE


# ---------------------------------------------------------------------------
# 2. abort during planning
# ---------------------------------------------------------------------------


def test_abort_during_planning(tmp_path: Path) -> None:
    """PLANNING 阶段 abort → ABORTED, run-state.json 含 aborted_at / aborted_reason."""
    run_dir = _make_run_dir(tmp_path)
    runner = RecordingWorkerRunner([])
    coord = Coordinator(run_dir, runner)
    coord.start_planning()
    assert coord.state.phase == Phase.PLANNING

    coord.abort(reason="人主动放弃 (test)")
    assert coord.state.phase == Phase.ABORTED
    assert coord.state.aborted_at is not None
    assert coord.state.aborted_reason == "人主动放弃 (test)"

    # 持久化检查
    persisted = read_run_state(run_dir)
    assert persisted.phase == Phase.ABORTED
    assert persisted.aborted_reason == "人主动放弃 (test)"
    assert persisted.aborted_at is not None


# ---------------------------------------------------------------------------
# 3. plan amendment during implementing
# ---------------------------------------------------------------------------


def test_plan_amendment_during_implementing(tmp_path: Path) -> None:
    """worker 返回 plan_amendment → coordinator compute_rollback + apply + 回 PLANNING."""
    run_dir = _make_run_dir(tmp_path)

    amendment = PlanAmendmentNeeded(
        reason="planned 用例 t1_happy 在实际代码中不可执行",
        touched_acceptance_refs=["AC-001"],
    )
    runner = RecordingWorkerRunner(
        [WorkerOutcome(status="plan_amendment", plan_amendment=amendment)]
    )
    coord = Coordinator(run_dir, runner)
    coord.start_planning()
    plan = _simple_plan()
    coord.submit_plan(plan)
    coord.signoff_plan(accepted=True)
    assert coord.state.phase == Phase.IMPLEMENTING

    # 跑一次 tick, worker 会返回 plan_amendment
    coord.run_tick()

    # coordinator 应已 compute_rollback + apply (T01 回 pending) + 回 PLANNING + 等 signoff
    assert coord.state.phase == Phase.PLANNING
    assert coord.state.human_pending == HumanPending.plan_signoff
    assert coord.plan is not None
    # T01 在 plan-amendment 后应回 pending (rollback recall running→pending)
    assert coord.plan.tasks[0].status == "pending"


# ---------------------------------------------------------------------------
# 4. hard gate task missing key-diffs blocks COMPLETE
# ---------------------------------------------------------------------------


def test_hard_gate_task_missing_key_diffs_blocks_complete(tmp_path: Path) -> None:
    """risk:high task 没交 key-diffs → 收口自检 fail, 不进 COMPLETE."""
    run_dir = _make_run_dir(tmp_path)

    # completed outcome 但不带 key-diffs
    runner = RecordingWorkerRunner([_completed_outcome(with_key_diffs=False)])
    coord = Coordinator(run_dir, runner)
    coord.start_planning()
    plan = _simple_plan(risk_high=True)  # risk:high → 触发硬 gate
    coord.submit_plan(plan)
    coord.signoff_plan(accepted=True)

    coord.run_until_human_or_terminal(max_ticks=10)

    # task 自检通过 (tests_green), 但 key-diffs 硬 gate 缺 → 收口自检 fail
    # 走到 WRAPPING_UP (auto submit_wrap_up), 但 human_pending 不设 (不通过)
    assert coord.state.phase == Phase.WRAPPING_UP
    assert coord.state.human_pending is None  # 收口自检没过, 不进 signoff

    # wrap-up/check-result.json 应含 all_hard_gates_pass = false
    result = (run_dir / "wrap-up" / "check-result.json").read_text(encoding="utf-8")
    assert "all_hard_gates_pass" in result
    # 找到 all_hard_gates_pass 项, 它应是 false
    import json
    items = json.loads(result)
    hard_gate_item = next(i for i in items if i["check"] == "all_hard_gates_pass")
    assert hard_gate_item["passed"] is False


# ---------------------------------------------------------------------------
# 5. watchdog recycle after timeout
# ---------------------------------------------------------------------------


def test_watchdog_recycle_after_timeout(tmp_path: Path) -> None:
    """worker 超时 (started_at 久远) → watchdog recycle, attempt+1."""
    run_dir = _make_run_dir(tmp_path)

    # RecordingWorkerRunner 给一个 "永不交回" 的 outcome —— 即 dispatch 返回 completed,
    # 但我们手动把 started_at 改成很久以前, 让 watchdog 判它 stale 并 recycle.
    # 简化: 先正常派发一个 completed, 自检通过 → complete (不会触发 watchdog).
    # 这个测试改用 "派一个失败的 outcome, 自检不通过 → 留 running → watchdog 回收" 的路径.
    bad_outcome = WorkerOutcome(
        status="completed",
        test_results=TestResults(tests_green=False, cases=[]),
    )
    # 预置两个 bad outcome: 第一次派发 + recycle 后第二次派发都用得上.
    runner = RecordingWorkerRunner([bad_outcome, bad_outcome])
    coord = Coordinator(run_dir, runner)
    coord.start_planning()
    plan = _simple_plan()
    coord.submit_plan(plan)
    coord.signoff_plan(accepted=True)

    # 跑一次 tick: worker 交回但自检不通过 → 留 running
    coord.run_tick()
    assert coord.plan is not None
    assert coord.plan.tasks[0].status == "running"
    assert "T01" in coord.started_at_by_task

    # 手动把 started_at 改成超时之前 (simple 档默认 15 min)
    coord.started_at_by_task["T01"] = datetime.now(timezone.utc) - timedelta(minutes=30)

    # 再跑一次 tick: watchdog 应判 stale 并 recycle (max_retries_per_task=1, stale_count=0<1)
    # recycle 后 ready_frontier 可能立即重派 (本次为阻塞派发, 第二个 outcome 也回来了),
    # 故 status 可能是 pending (recycle 后未重派) 或 running (recycle 后立即重派).
    # 关键判据: attempt 已 +1 (recycle 痕迹) + stale_count 已 +1.
    coord.run_tick()

    t = coord.plan.tasks[0]
    assert t.attempt == 1
    # stale_count 应已 +1
    assert coord.stale_count_by_task.get("T01") == 1
    # watchdog.json 应有一条 timeout 事件
    import json
    wd_path = run_dir / "tasks" / "T01" / "logs" / "watchdog.json"
    assert wd_path.exists(), "watchdog.json 应已写入"
    events = json.loads(wd_path.read_text(encoding="utf-8"))
    assert any(e["reason"] == "timeout" for e in events)


# ---------------------------------------------------------------------------
# 6. trust_mode refuses unattended
# ---------------------------------------------------------------------------


def test_trust_mode_refuses_unattended(tmp_path: Path) -> None:
    """switch_trust_mode → TrustModeSwitchRefused (unattended 通道未建, MVP)."""
    run_dir = _make_run_dir(tmp_path)
    runner = RecordingWorkerRunner([])
    coord = Coordinator(run_dir, runner)

    with pytest.raises(TrustModeSwitchRefused):
        switch_trust_mode(coord.state, TrustMode.unattended)

    # 仍可降档到 collaborative (无 gate)
    new_state = switch_trust_mode(coord.state, TrustMode.collaborative)
    assert new_state.trust_mode == TrustMode.collaborative
