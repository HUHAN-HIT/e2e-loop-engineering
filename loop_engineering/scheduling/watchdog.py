"""task `running` 的 watchdog 回收 (design §3.3).

规范源: design §3.3 —— worker 派出后失联回收. 要点:
- 心跳 / 超时: started_at + watchdog_timeout_min < now → 写 timeout 事件触发回收.
- 回收动作: task 退回 pending, active_tasks 移除, attempt +1, 写 watchdog.json 一条事件.
- 重试策略: 同 task 默认重派 max_retries_per_task 次; 仍 stale → 标 blocked.
- 整体推进: stale task 数 / 总 task 数 > 50% → 建议人转 ABORTED (按 task 计不按次计).
- watchdog 只处理 worker 失联, 不替代 §2 自检; 两者计数独立.

本模块**不持有** started_at / stale_count 等运行时状态 —— 这些由 coordinator 外部维护,
作为参数传入, 使本模块成为纯函数, 便于单测 (§3.5 AR3 收敛点).

诚实声明 (§3.3 迟到交回): 状态层由 apply_watchdog_decision + attempt 序号堵 (旧 attempt
迟到交回直接丢弃); 文件级残留 (旧 worker 已写入 allowed_write_paths 的双写) 机制消除不了,
本模块不强制处理, 最终兜底是 §2.3 收口 diff.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from ..schema.task_plan import Task, TaskStatus

__all__ = [
    "WatchdogEvent",
    "WatchdogDecision",
    "detect_stale_tasks",
    "watchdog_tick",
    "apply_watchdog_decision",
    "write_watchdog_event",
    "should_suggest_abort",
]


@dataclass(frozen=True)
class WatchdogEvent:
    """watchdog.json 里的一条事件记录.

    一条事件对应一次回收动作 (timeout / crash / no_response).
    """

    task_id: str
    reason: str  # "timeout" | "crash" | "no_response"
    attempt: int  # 此次作废的 attempt 序号
    timestamp: str  # ISO 8601 UTC
    started_at: str  # worker 派出时间 (用于诊断)


@dataclass(frozen=True)
class WatchdogDecision:
    """单次 watchdog_tick 对一个 task 的处置决策.

    action 三态:
    - recycle_to_pending: 超时且仍有重派额度, 退回 pending, attempt +1.
    - mark_blocked: 重派已耗尽仍 stale, 标 blocked, attempt 不变.
    - no_action: 未超时, 不动.
    """

    task_id: str
    action: str
    new_attempt: int
    new_status: TaskStatus
    reason: str
    event: WatchdogEvent | None  # no_action 时为 None


def _iso_utc(dt: datetime) -> str:
    """datetime → ISO 8601 UTC 字符串 (用作 timestamp / started_at)."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt.isoformat()


def detect_stale_tasks(
    tasks: list[Task],
    now: datetime,
    timeout_minutes: int,
    started_at_by_task: dict[str, datetime],
) -> list[Task]:
    """找出 running 且 started_at + timeout < now 的 task (design §3.3).

    started_at 由 coordinator 通过 started_at_by_task 外部传入 (本模块不持有).
    缺 started_at 的 running task 视为无法判定, 不算 stale (保守不回收).
    """
    timeout_seconds = timeout_minutes * 60
    stale: list[Task] = []
    for t in tasks:
        if t.status != TaskStatus.running:
            continue
        started = started_at_by_task.get(t.id)
        if started is None:
            continue
        elapsed = (now - started).total_seconds()
        if elapsed > timeout_seconds:
            stale.append(t)
    return stale


def watchdog_tick(
    tasks: list[Task],
    started_at_by_task: dict[str, datetime],
    stale_count_by_task: dict[str, int],
    now: datetime,
    timeout_minutes: int,
    max_retries: int,
) -> list[WatchdogDecision]:
    """单次 tick: 对每个 running task 检查超时, 决定 recycle / mark_blocked / no_action.

    决策矩阵 (§3.3):
    - 未超时 → no_action.
    - 超时且 stale_count < max_retries → recycle_to_pending (重派, attempt +1).
    - 超时且 stale_count >= max_retries → mark_blocked (重派额度耗尽, 升级给人).

    stale_count_by_task: coordinator 维护的"该 task 累计 stale 次数", tick 不修改它
    (apply 后由 coordinator 外部 +1, 与本模块解耦).
    """
    timeout_seconds = timeout_minutes * 60
    decisions: list[WatchdogDecision] = []
    for t in tasks:
        if t.status != TaskStatus.running:
            continue
        started = started_at_by_task.get(t.id)
        if started is None:
            continue
        elapsed = (now - started).total_seconds()
        if elapsed <= timeout_seconds:
            decisions.append(
                WatchdogDecision(
                    task_id=t.id,
                    action="no_action",
                    new_attempt=t.attempt,
                    new_status=TaskStatus.running,
                    reason="not_overdue",
                    event=None,
                )
            )
            continue

        stale_count = stale_count_by_task.get(t.id, 0)
        timestamp = _iso_utc(now)
        started_str = _iso_utc(started)

        if stale_count < max_retries:
            # 仍有重派额度 → 退回 pending 重派, attempt +1.
            decisions.append(
                WatchdogDecision(
                    task_id=t.id,
                    action="recycle_to_pending",
                    new_attempt=t.attempt + 1,
                    new_status=TaskStatus.pending,
                    reason="timeout",
                    event=WatchdogEvent(
                        task_id=t.id,
                        reason="timeout",
                        attempt=t.attempt,
                        timestamp=timestamp,
                        started_at=started_str,
                    ),
                )
            )
        else:
            # 重派额度耗尽 → 标 blocked, attempt 不变 (§3.3 "计数独立, 不共享额度").
            decisions.append(
                WatchdogDecision(
                    task_id=t.id,
                    action="mark_blocked",
                    new_attempt=t.attempt,
                    new_status=TaskStatus.blocked,
                    reason="max_retries_exhausted",
                    event=WatchdogEvent(
                        task_id=t.id,
                        reason="no_response",
                        attempt=t.attempt,
                        timestamp=timestamp,
                        started_at=started_str,
                    ),
                )
            )
    return decisions


def apply_watchdog_decision(task: Task, decision: WatchdogDecision) -> Task:
    """按 decision 修改 task (仅 status / attempt, 不动其他字段).

    用 model_copy 保留其他字段; no_action 决策也允许传入 (返回等价副本).
    """
    return task.model_copy(update={"status": decision.new_status, "attempt": decision.new_attempt})


def write_watchdog_event(run_dir: Path, decision: WatchdogDecision) -> None:
    """把 decision.event 追加到 tasks/<id>/logs/watchdog.json.

    文件不存在则建; 已存在则读出数组追加. 数组形式便于人查回收历史.
    no_action 决策的 event 为 None → 不写.
    """
    if decision.event is None:
        return
    log_path = run_dir / "tasks" / decision.task_id / "logs" / "watchdog.json"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    events: list[dict] = []
    if log_path.exists():
        try:
            raw = json.loads(log_path.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                events = raw
        except (json.JSONDecodeError, OSError):
            # 损坏文件不阻塞回收, 从空重新写 (人后续可查 git 历史).
            events = []
    events.append(
        {
            "task_id": decision.event.task_id,
            "reason": decision.event.reason,
            "attempt": decision.event.attempt,
            "timestamp": decision.event.timestamp,
            "started_at": decision.event.started_at,
        }
    )
    log_path.write_text(
        json.dumps(events, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def should_suggest_abort(
    tasks: list[Task],
    stale_count_by_task: dict[str, int],
    threshold: float = 0.5,
) -> bool:
    """§3.3: 发生过 ≥1 次 stale 的 task 数 / 总 task 数 > threshold → True.

    分子分母都按 task 计不按次计 (同一 task 多次 stale 只算 1).
    总 task 数为 0 时返回 False (避免除零).
    """
    total = len(tasks)
    if total == 0:
        return False
    stale_task_count = sum(1 for tid in stale_count_by_task if stale_count_by_task[tid] >= 1)
    return (stale_task_count / total) > threshold
