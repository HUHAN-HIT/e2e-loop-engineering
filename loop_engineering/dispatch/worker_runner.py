"""WorkerRunner 抽象 (design master-prompt §3 运行模式自适应).

规范源: master-prompt §3 —— WorkerRunner 有两形态:
- 真实形态 (Claude Code subagent 隔离): 由宿主提供, MVP 不实现具体.
- 兜底形态 (单上下文 / 测试): 同进程内'扮演' worker, InlineWorkerRunner + RecordingWorkerRunner.

WorkerOutcome 是 worker 跑完的回收结果三态 (completed / plan_amendment / failed),
对应 design §3.6 (plan_amendment) 与 §2.2 (任务自检的输入).
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable

from ..schema.artifacts import (
    KeyDiffsFile,
    PlanAmendmentNeeded,
    TestResults,
)
from .packet import WorkerPacket

__all__ = [
    "WorkerOutcome",
    "WorkerRunner",
    "InlineWorkerRunner",
    "RecordingWorkerRunner",
]


def _now_utc() -> datetime:
    """UTC 当前时间 (default_factory 不接受 lambda 直接调用, 封装一下)."""
    return datetime.now(timezone.utc)


@dataclass(frozen=True)
class WorkerOutcome:
    """worker 跑完的回收结果. 三态 (design §3.6 + §2.2).

    status=completed: 正常完成, test_results 给出测试结果.
    status=plan_amendment: worker 发现 planned 用例不可执行或本身错了, 返回 plan_amendment.
    status=failed: worker 报告自己跑挂了 (crash / 内部错误), failure_reason 描述原因.

    Attributes:
        status: 三态之一.
        test_results: status=completed 时由 worker 交回的 test-results.yaml 解析结果.
        summary_text: worker 写到 summary.md 的内容 (或路径, MVP 用内联文本).
        key_diffs_file: status=completed 时可附带的 key-diffs.yaml (None = 未提交).
        plan_amendment: status=plan_amendment 时必填.
        failure_reason: status=failed 时的失败原因.
        started_at / finished_at: 用于诊断与 watchdog 的辅助时间戳 (UTC).
    """

    status: str
    test_results: TestResults | None = None
    summary_text: str = ""
    key_diffs_file: KeyDiffsFile | None = None
    plan_amendment: PlanAmendmentNeeded | None = None
    failure_reason: str = ""
    started_at: datetime = field(default_factory=_now_utc)
    finished_at: datetime | None = None


class WorkerRunner(ABC):
    """worker 派发抽象.

    真实实现由宿主提供 (Claude Code subagent / inline mock). 本接口只约束契约:
    dispatch 是阻塞调用, 派一个 worker 跑完一个 task 再返回.
    失败 (timeout / crash / 失联) 不在 dispatch 内处理 —— 那是 watchdog 的事 (§3.3).
    本方法只返正常交回的 outcome.
    """

    @abstractmethod
    def dispatch(self, packet: WorkerPacket, *, system_prompt: str = "") -> WorkerOutcome:
        """派发一个 worker, 阻塞等回收."""


class InlineWorkerRunner(WorkerRunner):
    """单上下文兜底模式 (master-prompt §3 A2): 同一进程内'扮演' worker.

    MVP 通过 callback 注入, 不打 LLM. callback 签名:
        callback(packet: WorkerPacket) -> WorkerOutcome
    用于 dry-run 测试与单上下文宿主.
    """

    def __init__(self, worker_callback: Callable[[WorkerPacket], WorkerOutcome]):
        self._callback = worker_callback

    def dispatch(self, packet: WorkerPacket, *, system_prompt: str = "") -> WorkerOutcome:
        return self._callback(packet)


class RecordingWorkerRunner(WorkerRunner):
    """测试用: 把 packet 记录下来, 返回预置 outcome 队列.

    典型场景: 端到端 dry-run 测试预置一个 completed outcome, 不依赖真实 worker.
    outcomes 队列按 dispatch 顺序消费; 队列耗尽时 raise (测试编排错误).
    """

    def __init__(self, outcomes: list[WorkerOutcome]):
        self._outcomes = list(outcomes)
        self.dispatched_packets: list[WorkerPacket] = []

    def dispatch(self, packet: WorkerPacket, *, system_prompt: str = "") -> WorkerOutcome:
        self.dispatched_packets.append(packet)
        if not self._outcomes:
            raise RuntimeError("no more preset outcomes (RecordingWorkerRunner 队列耗尽)")
        return self._outcomes.pop(0)
