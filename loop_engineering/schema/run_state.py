"""Run 级状态模型.

规范源: design §6 (Run 目录与 Schema)、§3.3 (watchdog 阈值)、§3.4 (capabilities 探测)、
§8.1 (ABORTED 语义).

run-state.json 是 run 的单一活动状态源, 由 coordinator 单写者维护.
"""
from __future__ import annotations

import json
from enum import StrEnum
from pathlib import Path

from pydantic import BaseModel, model_validator


class Phase(StrEnum):
    """run 级 phase (design §6 / §1 / §8.1).

    CREATED → CLARIFYING(可选) → PLANNING → IMPLEMENTING → WRAPPING_UP → COMPLETE
    任意 phase 均可由人显式放弃 → ABORTED.
    """

    CREATED = "CREATED"
    CLARIFYING = "CLARIFYING"
    PLANNING = "PLANNING"
    IMPLEMENTING = "IMPLEMENTING"
    WRAPPING_UP = "WRAPPING_UP"
    COMPLETE = "COMPLETE"
    ABORTED = "ABORTED"


class Complexity(StrEnum):
    """复杂度档位 (design §1.1), 决定摩擦预算而非单个 task 内部实现."""

    simple = "simple"
    medium = "medium"
    complex = "complex"


class TrustMode(StrEnum):
    """信任档位 (design §5).

    collaborative (默认): 人盯计划与收口.
    unattended: 无人值守, 启用独立复跑通道 (§0.3 保留, MVP 未实现).
    """

    collaborative = "collaborative"
    unattended = "unattended"


class HumanPending(StrEnum):
    """人介入时机 (design §1, §6).

    null 表示无需人介入, 系统自动推进.
    三类非空值分别对应三类人盯点.
    """

    clarification = "clarification"
    plan_signoff = "plan_signoff"
    wrap_up_signoff = "wrap_up_signoff"


class RunCapabilities(BaseModel):
    """宿主能力探测结果 (design §3.4).

    CREATED 时由 coordinator 一次性探测写入, 决定 actual_writes 走独立采集还是回退 worker 自报.
    不预设 True, 以探测结果为准.
    """

    git_diff: bool = False
    fs_snapshot: bool = False


class WatchdogTimeouts(BaseModel):
    """各复杂度档位的 watchdog 超时分钟数 (design §3.3).

    complex task 正常耗时更长, 阈值更宽, 避免把正常 worker 误判失联反复重派.
    """

    simple: int = 15
    medium: int = 30
    complex: int = 60


class RunConfig(BaseModel):
    """运行参数的单一落点 (design §6), 供 watchdog 与调度引用, 改阈值只改这里."""

    watchdog_timeout_min: WatchdogTimeouts = WatchdogTimeouts()
    max_retries_per_task: int = 1
    max_concurrency: int = 4


class RunState(BaseModel):
    """run-state.json 的极简 schema (design §6).

    核心字段 + 两个可选机制字段 (capabilities / config). ABORTED 时附加 aborted_at / aborted_reason.
    """

    run_id: str
    phase: Phase = Phase.CREATED
    complexity: Complexity
    trust_mode: TrustMode = TrustMode.collaborative
    human_pending: HumanPending | None = None
    active_tasks: list[str] = []
    key_artifacts: list[str] = []
    capabilities: RunCapabilities | None = None
    config: RunConfig = RunConfig()
    aborted_at: str | None = None
    aborted_reason: str | None = None

    @model_validator(mode="after")
    def _check_aborted_consistency(self) -> "RunState":
        """ABORTED 语义校验 (design §8.1, §6).

        - phase == ABORTED 时 aborted_at 必须非 None.
        - phase != ABORTED 时 aborted_at 与 aborted_reason 必须为 None (避免误导).
        """
        if self.phase == Phase.ABORTED:
            if self.aborted_at is None:
                raise ValueError(
                    "phase == ABORTED 时 aborted_at 必须非 None (design §8.1)"
                )
        else:
            if self.aborted_at is not None or self.aborted_reason is not None:
                raise ValueError(
                    "phase != ABORTED 时 aborted_at 与 aborted_reason 必须为 None "
                    "(design §6: 其它 phase 下这两个字段不出现在文件里, 避免误导)"
                )
        return self

    def to_json_file(self, path: Path) -> None:
        """序列化到 run-state.json (排除 None 字段以保持极简)."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            self.model_dump_json(exclude_none=True, indent=2),
            encoding="utf-8",
        )

    @classmethod
    def from_json_file(cls, path: Path) -> "RunState":
        """从 run-state.json 反序列化."""
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls.model_validate(data)
