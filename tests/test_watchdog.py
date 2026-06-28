"""watchdog 模块测试 (design §3.3).

覆盖:
- detect_stale_tasks: running + 超时 / 非 running / 未超时.
- watchdog_tick: recycle / mark_blocked / no_action.
- apply_watchdog_decision: status / attempt 修改正确.
- write_watchdog_event: 追加 / 建文件.
- should_suggest_abort: 阈值 / 按 task 计不按次计.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from loop_engineering.scheduling.watchdog import (
    WatchdogDecision,
    WatchdogEvent,
    apply_watchdog_decision,
    detect_stale_tasks,
    should_suggest_abort,
    watchdog_tick,
    write_watchdog_event,
)
from loop_engineering.schema.task_plan import Task, TaskStatus


def _make_task(
    task_id: str = "T1",
    status: TaskStatus = TaskStatus.running,
    attempt: int = 0,
) -> Task:
    """构造测试 task (最小字段)."""
    return Task(
        id=task_id,
        title=f"task {task_id}",
        allowed_write_paths=["a/**"],
        acceptance_refs=["AC1"],
        status=status,
        attempt=attempt,
    )


# ---------------------------------------------------------------------------
# detect_stale_tasks
# ---------------------------------------------------------------------------


def test_detect_stale_tasks_finds_overdue() -> None:
    """running + started_at 久远 + 超时 → 找到."""
    now = datetime(2026, 6, 27, 12, 0, tzinfo=timezone.utc)
    started = now - timedelta(minutes=30)
    tasks = [_make_task("T1")]
    started_map = {"T1": started}
    stale = detect_stale_tasks(tasks, now, timeout_minutes=15, started_at_by_task=started_map)
    assert stale == tasks


def test_detect_stale_tasks_skips_non_running() -> None:
    """pending / complete / blocked 不算 stale."""
    now = datetime(2026, 6, 27, 12, 0, tzinfo=timezone.utc)
    started = now - timedelta(hours=10)
    tasks = [
        _make_task("T1", status=TaskStatus.pending),
        _make_task("T2", status=TaskStatus.complete),
        _make_task("T3", status=TaskStatus.blocked),
    ]
    started_map = {t.id: started for t in tasks}
    stale = detect_stale_tasks(tasks, now, timeout_minutes=15, started_at_by_task=started_map)
    assert stale == []


def test_detect_stale_tasks_skips_recent() -> None:
    """running + 未超时 → 不算 stale."""
    now = datetime(2026, 6, 27, 12, 0, tzinfo=timezone.utc)
    started = now - timedelta(minutes=5)
    tasks = [_make_task("T1")]
    started_map = {"T1": started}
    stale = detect_stale_tasks(tasks, now, timeout_minutes=15, started_at_by_task=started_map)
    assert stale == []


def test_detect_stale_tasks_skips_running_without_started_at() -> None:
    """running 但缺 started_at → 保守不回收 (无法判定)."""
    now = datetime(2026, 6, 27, 12, 0, tzinfo=timezone.utc)
    tasks = [_make_task("T1")]
    stale = detect_stale_tasks(tasks, now, timeout_minutes=15, started_at_by_task={})
    assert stale == []


# ---------------------------------------------------------------------------
# watchdog_tick
# ---------------------------------------------------------------------------


def test_watchdog_tick_recycle_on_first_timeout() -> None:
    """stale_count=0, max_retries=1 → recycle, new_attempt=1."""
    now = datetime(2026, 6, 27, 12, 0, tzinfo=timezone.utc)
    started = now - timedelta(minutes=30)
    tasks = [_make_task("T1", attempt=0)]
    decisions = watchdog_tick(
        tasks,
        started_at_by_task={"T1": started},
        stale_count_by_task={"T1": 0},
        now=now,
        timeout_minutes=15,
        max_retries=1,
    )
    assert len(decisions) == 1
    d = decisions[0]
    assert d.action == "recycle_to_pending"
    assert d.new_attempt == 1
    assert d.new_status == TaskStatus.pending
    assert d.event is not None
    assert d.event.reason == "timeout"
    assert d.event.attempt == 0


def test_watchdog_tick_block_after_max_retries() -> None:
    """stale_count=1 (=max_retries), 再次超时 → mark_blocked, attempt 不变."""
    now = datetime(2026, 6, 27, 12, 0, tzinfo=timezone.utc)
    started = now - timedelta(minutes=30)
    tasks = [_make_task("T1", attempt=1)]
    decisions = watchdog_tick(
        tasks,
        started_at_by_task={"T1": started},
        stale_count_by_task={"T1": 1},
        now=now,
        timeout_minutes=15,
        max_retries=1,
    )
    assert len(decisions) == 1
    d = decisions[0]
    assert d.action == "mark_blocked"
    assert d.new_attempt == 1
    assert d.new_status == TaskStatus.blocked
    assert d.event is not None
    assert d.event.reason == "no_response"


def test_watchdog_tick_no_action_when_not_overdue() -> None:
    """未超时 → no_action."""
    now = datetime(2026, 6, 27, 12, 0, tzinfo=timezone.utc)
    started = now - timedelta(minutes=5)
    tasks = [_make_task("T1", attempt=0)]
    decisions = watchdog_tick(
        tasks,
        started_at_by_task={"T1": started},
        stale_count_by_task={},
        now=now,
        timeout_minutes=15,
        max_retries=1,
    )
    assert len(decisions) == 1
    d = decisions[0]
    assert d.action == "no_action"
    assert d.new_attempt == 0
    assert d.new_status == TaskStatus.running
    assert d.event is None


# ---------------------------------------------------------------------------
# apply_watchdog_decision
# ---------------------------------------------------------------------------


def test_apply_watchdog_decision_recycle() -> None:
    """recycle 后 status=pending, attempt=旧值+1, 其他字段不变."""
    task = _make_task("T1", attempt=0)
    decision = WatchdogDecision(
        task_id="T1",
        action="recycle_to_pending",
        new_attempt=1,
        new_status=TaskStatus.pending,
        reason="timeout",
        event=WatchdogEvent(
            task_id="T1",
            reason="timeout",
            attempt=0,
            timestamp="2026-06-27T12:00:00+00:00",
            started_at="2026-06-27T11:30:00+00:00",
        ),
    )
    new_task = apply_watchdog_decision(task, decision)
    assert new_task.status == TaskStatus.pending
    assert new_task.attempt == 1
    # 其他字段保留.
    assert new_task.id == "T1"
    assert new_task.title == "task T1"
    assert new_task.allowed_write_paths == ["a/**"]


def test_apply_watchdog_decision_block() -> None:
    """block 后 status=blocked, attempt 不变, 其他字段不变."""
    task = _make_task("T1", attempt=1)
    decision = WatchdogDecision(
        task_id="T1",
        action="mark_blocked",
        new_attempt=1,
        new_status=TaskStatus.blocked,
        reason="max_retries_exhausted",
        event=WatchdogEvent(
            task_id="T1",
            reason="no_response",
            attempt=1,
            timestamp="2026-06-27T12:00:00+00:00",
            started_at="2026-06-27T11:30:00+00:00",
        ),
    )
    new_task = apply_watchdog_decision(task, decision)
    assert new_task.status == TaskStatus.blocked
    assert new_task.attempt == 1
    assert new_task.id == "T1"


# ---------------------------------------------------------------------------
# write_watchdog_event
# ---------------------------------------------------------------------------


def test_write_watchdog_event_creates_file_if_missing(tmp_run_dir: Path) -> None:
    """文件不存在 → 建."""
    decision = WatchdogDecision(
        task_id="T1",
        action="recycle_to_pending",
        new_attempt=1,
        new_status=TaskStatus.pending,
        reason="timeout",
        event=WatchdogEvent(
            task_id="T1",
            reason="timeout",
            attempt=0,
            timestamp="2026-06-27T12:00:00+00:00",
            started_at="2026-06-27T11:30:00+00:00",
        ),
    )
    log_path = tmp_run_dir / "tasks" / "T1" / "logs" / "watchdog.json"
    assert not log_path.exists()
    write_watchdog_event(tmp_run_dir, decision)
    assert log_path.exists()
    data = json.loads(log_path.read_text(encoding="utf-8"))
    assert isinstance(data, list)
    assert len(data) == 1
    assert data[0]["task_id"] == "T1"
    assert data[0]["reason"] == "timeout"
    assert data[0]["attempt"] == 0


def test_write_watchdog_event_appends_to_log(tmp_run_dir: Path) -> None:
    """已存在 → 追加, 不覆盖."""
    log_path = tmp_run_dir / "tasks" / "T1" / "logs" / "watchdog.json"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    existing = [
        {
            "task_id": "T1",
            "reason": "timeout",
            "attempt": 0,
            "timestamp": "2026-06-27T11:00:00+00:00",
            "started_at": "2026-06-27T10:30:00+00:00",
        }
    ]
    log_path.write_text(json.dumps(existing), encoding="utf-8")

    decision = WatchdogDecision(
        task_id="T1",
        action="mark_blocked",
        new_attempt=1,
        new_status=TaskStatus.blocked,
        reason="max_retries_exhausted",
        event=WatchdogEvent(
            task_id="T1",
            reason="no_response",
            attempt=1,
            timestamp="2026-06-27T12:00:00+00:00",
            started_at="2026-06-27T11:30:00+00:00",
        ),
    )
    write_watchdog_event(tmp_run_dir, decision)
    data = json.loads(log_path.read_text(encoding="utf-8"))
    assert isinstance(data, list)
    assert len(data) == 2
    assert data[0]["attempt"] == 0
    assert data[1]["attempt"] == 1
    assert data[1]["reason"] == "no_response"


def test_write_watchdog_event_no_action_does_nothing(tmp_run_dir: Path) -> None:
    """no_action 决策 (event=None) 不写文件."""
    decision = WatchdogDecision(
        task_id="T1",
        action="no_action",
        new_attempt=0,
        new_status=TaskStatus.running,
        reason="not_overdue",
        event=None,
    )
    log_path = tmp_run_dir / "tasks" / "T1" / "logs" / "watchdog.json"
    write_watchdog_event(tmp_run_dir, decision)
    assert not log_path.exists()


# ---------------------------------------------------------------------------
# should_suggest_abort
# ---------------------------------------------------------------------------


def test_should_suggest_abort_above_threshold() -> None:
    """超过 50% task 有 stale → True (design §3.3 严格'超过')."""
    tasks = [_make_task("T1"), _make_task("T2"), _make_task("T3")]
    stale_counts = {"T1": 1, "T2": 1, "T3": 0}  # 2/3 ≈ 0.67 > 0.5
    assert should_suggest_abort(tasks, stale_counts, threshold=0.5) is True


def test_should_suggest_abort_counts_tasks_not_instances() -> None:
    """同一 task 多次 stale 只算 1 (§3.3 关键)."""
    tasks = [_make_task("T1"), _make_task("T2")]
    # T1 反复 stale 5 次, 但分子只算 1 个 task.
    stale_counts = {"T1": 5, "T2": 0}
    assert should_suggest_abort(tasks, stale_counts, threshold=0.5) is False


def test_should_suggest_abort_below_threshold() -> None:
    """10% → False."""
    tasks = [_make_task(t) for t in ("T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10")]
    stale_counts = {"T1": 1}  # 1/10 = 10%
    assert should_suggest_abort(tasks, stale_counts, threshold=0.5) is False


def test_should_suggest_abort_empty_tasks() -> None:
    """总 task 数为 0 → False (避免除零)."""
    assert should_suggest_abort([], {}, threshold=0.5) is False


def test_should_suggest_abort_exactly_at_threshold_is_false() -> None:
    """严格大于 threshold (1/2 = 0.5 不 > 0.5) → False."""
    tasks = [_make_task("T1"), _make_task("T2")]
    stale_counts = {"T1": 1, "T2": 0}
    assert should_suggest_abort(tasks, stale_counts, threshold=0.5) is False
