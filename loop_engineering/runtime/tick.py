"""单 tick 顺序 (design §3.7): ABORTED > 收回 outcomes > watchdog > ready_frontier.

规范源: design §3.7 —— 单次 tick 的执行顺序严格固定:
1. ABORTED check: 若 state.phase==ABORTED → 立即返回 (不再调度, 优先级最高).
2. 收回已交回的 worker_outcomes: 跑 collect_outcome + 任务自检; pass→complete, fail→保留 running
   等待 fix-once (§2.2); plan_amendment → 交回 caller (coordinator) 处理回滚.
3. watchdog_tick: 检查 running task 是否超时, recycle / mark_blocked.
4. ready_frontier: 选 ready task, 立即翻 running, 派发 WorkerPacket.
5. 应付人锚点: 若进入 PLANNING/WRAPPING_UP 末尾, 设置 human_pending.

本函数是纯函数风格: 输入 state + plan + runner, 返回新 (state, plan, TickResult).
不可变 (model_copy / 新对象), 不修改入参.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from ..dispatch.collect import collect_outcome
from ..dispatch.packet import WorkerPacket, build_packet
from ..dispatch.worker_runner import WorkerOutcome, WorkerRunner
from ..scheduling.ready_frontier import ready_frontier
from ..scheduling.watchdog import (
    WatchdogDecision,
    apply_watchdog_decision,
    should_suggest_abort,
    watchdog_tick,
    write_watchdog_event,
)
from ..schema.run_state import Phase, RunCapabilities, RunState
from ..schema.task_plan import Task, TaskPlan, TaskStatus

__all__ = ["TickResult", "tick"]


@dataclass(frozen=True)
class TickResult:
    """单次 tick 的执行记录 (用于日志 + 测试)."""

    aborted_check: bool
    """是否触发 ABORTED 短路 (优先级最高)."""

    watchdog_actions: list[WatchdogDecision] = field(default_factory=list)
    """本 tick 的 watchdog 决策 (no_action 也算)."""

    ready_selected: list[str] = field(default_factory=list)
    """本批 ready_frontier 选中的 task_id."""

    dispatched: list[str] = field(default_factory=list)
    """实际派发的 task_id (ready_selected 中能派发的)."""

    human_pending_now: bool = False
    """tick 后是否需要等人 (anchor 被设置)."""

    suggested_abort: bool = False
    """watchdog 建议 ABORTED (stale 占比 > 50%, design §3.3)."""

    plan_amendments: list = field(default_factory=list)
    """本 tick 收到的 plan_amendment 信号列表 (CollectedTaskResult 形式),
    coordinator 拿到后跑 compute_rollback + apply. tick 自身不处理回滚."""

    completed_results: list = field(default_factory=list)
    """本 tick 内自检通过转为 complete 的 task 的 CollectedTaskResult 列表.
    coordinator 拿来填充 _key_diffs_by_task / _task_check_results 给收口自检用."""


def _phase_timeout_minutes(state: RunState, complexity_str: str) -> int:
    """按当前 run 的复杂度档位取 watchdog 超时分钟数."""
    # 直接读 config 字段 (RunConfig 已有 simple/medium/complex 三个字段).
    cfg = state.config
    if complexity_str == "simple":
        return cfg.watchdog_timeout_min.simple
    if complexity_str == "medium":
        return cfg.watchdog_timeout_min.medium
    return cfg.watchdog_timeout_min.complex


def tick(
    state: RunState,
    plan: TaskPlan,
    runner: WorkerRunner,
    *,
    started_at_by_task: dict[str, datetime],
    stale_count_by_task: dict[str, int],
    now: datetime,
    worker_outcomes: dict[str, WorkerOutcome] | None = None,
    capabilities: RunCapabilities | None = None,
    before_snapshots: dict[str, dict[str, float]] | None = None,
    earlier_task_writes: dict[str, list[str]] | None = None,
    design_md: Path | None = None,
    task_plan_yaml: Path | None = None,
    run_dir: Path | None = None,
) -> tuple[RunState, TaskPlan, TickResult]:
    """单 tick. 严格按 §3.7 顺序执行.

    Args:
        state: 当前 RunState.
        plan: 当前 TaskPlan.
        runner: WorkerRunner (派发用).
        started_at_by_task: task_id → 派出时间 (watchdog 用).
        stale_count_by_task: task_id → 累计 stale 次数 (watchdog 用).
        now: 当前时间 (注入, 便于测试).
        worker_outcomes: 上一轮 dispatch 的回填 outcome (task_id → outcome).
        capabilities: 宿主能力 (None 时 collect 用 self_report 兜底).
        before_snapshots: task_id → 派出前的 fs snapshot (actual_writes 采集用).
        earlier_task_writes: task_id → 该 task 的实际写入列表 (越界检测第 2 层用).
        design_md / task_plan_yaml / run_dir: build_packet 用.

    Returns:
        (new_state, new_plan, TickResult). 不可变风格.
    """
    # 步骤 1: ABORTED check (优先级最高)
    if state.phase == Phase.ABORTED:
        return state, plan, TickResult(aborted_check=True)

    worker_outcomes = worker_outcomes or {}
    capabilities = capabilities or RunCapabilities()
    before_snapshots = before_snapshots or {}
    earlier_task_writes = earlier_task_writes or {}

    new_active: list[str] = list(state.active_tasks)
    collected_amendments: list = []
    collected_completed: list = []
    dispatched_ids: list[str] = []
    new_plan: TaskPlan = plan  # 初始引用, 后续步骤会 model_copy 更新

    # 内部辅助: 处理一个 running task 的 outcome 回收.
    # 总是从最新 self.new_plan.tasks 取 (因为 watchdog 步骤会重建 new_plan).
    def _consume_outcome(task_id: str, outcome: WorkerOutcome) -> None:
        """处理一个 outcome: 自检通过 → complete; plan_amendment → 收集; 其它 → 留 running."""
        nonlocal new_plan
        # 从当前 new_plan.tasks 找最新 task 状态
        current_tasks = list(new_plan.tasks)
        idx = next((i for i, t in enumerate(current_tasks) if t.id == task_id), None)
        if idx is None:
            return
        task = current_tasks[idx]
        if task.status != TaskStatus.running:
            # 任务已不在 running (例如已被 watchdog 回收), 丢弃迟到 outcome.
            return

        packet = build_packet(
            task,
            new_plan,
            run_dir or Path("."),
            design_md=design_md or Path("planning/design.md"),
            task_plan_yaml=task_plan_yaml or Path("planning/task-plan.yaml"),
        )

        collected = collect_outcome(
            task,
            outcome,
            packet,
            capabilities,
            before_snapshot=before_snapshots.get(task_id),
            earlier_task_writes=earlier_task_writes,
        )

        if outcome.status == "plan_amendment":
            collected_amendments.append(collected)
            return

        if outcome.status == "completed" and collected.task_check_result.all_pass:
            current_tasks[idx] = task.model_copy(update={"status": TaskStatus.complete})
            new_plan = new_plan.model_copy(update={"tasks": current_tasks})
            if task_id in new_active:
                new_active.remove(task_id)
            started_at_by_task.pop(task_id, None)
            # 回写 earlier_task_writes (后续 task 越界检测第 2 层用)
            earlier_task_writes[task_id] = list(collected.actual_writes.writes)
            # 收集 complete 结果给 coordinator (填 key_diffs / task_check 缓存)
            collected_completed.append(collected)
        # 其它情况: 保留 running, 等 watchdog 或下一次 fix-once.

    # 步骤 2: 收回已交回的 worker_outcomes (上一轮外部预填的 outcome)
    # 阻塞派发模型下, 步骤 4 派发得到的 outcome 会在当 tick 内立即走 _consume_outcome.
    for tid, outcome in list(worker_outcomes.items()):
        _consume_outcome(tid, outcome)
        # 消费完从外部 dict 撤出, 避免重复处理
        worker_outcomes.pop(tid, None)

    new_state = state.model_copy(update={"active_tasks": new_active})

    # 步骤 3: watchdog_tick (检查 running task 是否超时)
    timeout_min = _phase_timeout_minutes(state, plan.complexity.value)
    decisions = watchdog_tick(
        new_plan.tasks,
        started_at_by_task,
        stale_count_by_task,
        now,
        timeout_min,
        state.config.max_retries_per_task,
    )

    # 应用 watchdog 决策 (修改 task.status / attempt, 写 watchdog 事件)
    watchdog_tasks: list[Task] = list(new_plan.tasks)
    for dec in decisions:
        if dec.action == "no_action":
            continue
        idx = next((i for i, t in enumerate(watchdog_tasks) if t.id == dec.task_id), None)
        if idx is None:
            continue
        watchdog_tasks[idx] = apply_watchdog_decision(watchdog_tasks[idx], dec)
        # active_tasks 跟随状态变化
        if dec.action == "recycle_to_pending" or dec.action == "mark_blocked":
            if dec.task_id in new_active:
                new_active.remove(dec.task_id)
            started_at_by_task.pop(dec.task_id, None)
            if dec.action == "recycle_to_pending":
                stale_count_by_task[dec.task_id] = (
                    stale_count_by_task.get(dec.task_id, 0) + 1
                )
        if run_dir is not None:
            write_watchdog_event(run_dir, dec)

    new_plan = new_plan.model_copy(update={"tasks": watchdog_tasks})
    new_state = new_state.model_copy(update={"active_tasks": list(new_active)})

    suggested_abort = should_suggest_abort(new_plan.tasks, stale_count_by_task)

    # 步骤 4: ready_frontier + 派发
    # 仅在 IMPLEMENTING phase 才走 ready_frontier 派发.
    ready_ids: list[str] = []
    if new_state.phase == Phase.IMPLEMENTING:
        active_task_objs = [t for t in new_plan.tasks if t.id in new_active]
        ready = ready_frontier(new_plan.tasks, active_task_objs)
        ready_ids = [t.id for t in ready]

        for t in ready:
            # 立即翻 running (修改 new_plan.tasks)
            cur_tasks = list(new_plan.tasks)
            idx = next(i for i, x in enumerate(cur_tasks) if x.id == t.id)
            running_task = cur_tasks[idx].model_copy(
                update={"status": TaskStatus.running}
            )
            cur_tasks[idx] = running_task
            new_plan = new_plan.model_copy(update={"tasks": cur_tasks})
            new_active.append(t.id)

            # 派发
            packet = build_packet(
                running_task,
                new_plan,
                run_dir or Path("."),
                design_md=design_md or Path("planning/design.md"),
                task_plan_yaml=task_plan_yaml or Path("planning/task-plan.yaml"),
            )
            # 取派发前 snapshot (capabilities.fs_snapshot=True 时)
            if capabilities.fs_snapshot:
                from ..scheduling.actual_writes import take_fs_snapshot
                before_snapshots[t.id] = take_fs_snapshot(packet.workdir)

            outcome = runner.dispatch(packet)
            started_at_by_task[t.id] = now
            dispatched_ids.append(t.id)
            # 阻塞派发: outcome 在当 tick 内立即消费 (不存到 worker_outcomes).
            _consume_outcome(t.id, outcome)

    new_state = new_state.model_copy(update={"active_tasks": list(new_active)})
    new_plan_v2 = new_plan

    # 步骤 5: 应付人锚点 (PLANNING/WRAPPING_UP 末尾)
    # tick 自身不主动设 human_pending —— 那是 coordinator 的 submit_* 方法的事.
    # 这里只透传 is_awaiting_human 状态.
    human_pending_now = new_state.human_pending is not None

    return (
        new_state,
        new_plan_v2,
        TickResult(
            aborted_check=False,
            watchdog_actions=decisions,
            ready_selected=ready_ids,
            dispatched=dispatched_ids,
            human_pending_now=human_pending_now,
            suggested_abort=suggested_abort,
            plan_amendments=collected_amendments,
            completed_results=collected_completed,
        ),
    )
