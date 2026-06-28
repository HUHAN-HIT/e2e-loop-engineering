"""§5 trust_mode 切档 gate.

规范源: design §5 (信任档位) + §0.3 (独立复跑通道保留, MVP 未实现).

核心契约: 切到 unattended 前必须 probe, 不就绪就拒绝 (TrustModeSwitchRefused).
拒绝静默降级 —— "默默从 unattended 退回 collaborative" 是不可接受的, 必须显式 raise.
MVP 默认 unattended 通道未建, probe 返回 False.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from loop_engineering.schema.run_state import RunState, TrustMode


@dataclass(frozen=True)
class UnattendedReadiness:
    """unattended 档的就绪状态探测结果.

    Attributes:
        independent_replay_channel_ready: §0.3 保留的独立复跑通道是否建好.
            MVP 未实现, 默认 False.
        reasons: 未就绪的诊断 (空列表 = 已就绪).
    """

    independent_replay_channel_ready: bool
    reasons: list[str] = field(default_factory=list)


def probe_unattended_readiness() -> UnattendedReadiness:
    """探测独立复跑通道是否就绪.

    MVP 实现: 默认 False, reason 提示通道未建. 真实探测留给后续
    (检测 capability flag / 入口文件存在等).
    """
    return UnattendedReadiness(
        independent_replay_channel_ready=False,
        reasons=["独立复跑通道未建 (§0.3 保留, §7 MVP 未实现)"],
    )


def can_switch_to_unattended(readiness: UnattendedReadiness) -> bool:
    """ready → True; 否则 False."""
    return readiness.independent_replay_channel_ready


class TrustModeSwitchRefused(ValueError):
    """切档被拒.

    Attributes:
        target: 被拒绝切往的目标档位.
        reasons: 拒绝原因列表 (来自 readiness.reasons).
    """

    def __init__(self, target: TrustMode, reasons: list[str]) -> None:
        self.target = target
        self.reasons = list(reasons)
        super().__init__(
            f"trust_mode 切到 {target.value!r} 被拒: {self.reasons}"
        )


def switch_trust_mode(state: RunState, target: TrustMode) -> RunState:
    """切档入口 (返回新 RunState, 不修改原 state).

    Args:
        state: 当前 RunState.
        target: 目标档位.

    Returns:
        新 RunState (model_copy 后 trust_mode 更新).

    Raises:
        TrustModeSwitchRefused: target=unattended 且 readiness 未就绪.
    """
    if target == TrustMode.collaborative:
        # 降档永远允许 (无 gate)
        return state.model_copy(update={"trust_mode": TrustMode.collaborative})

    if target == TrustMode.unattended:
        readiness = probe_unattended_readiness()
        if not can_switch_to_unattended(readiness):
            raise TrustModeSwitchRefused(target=target, reasons=list(readiness.reasons))
        return state.model_copy(update={"trust_mode": TrustMode.unattended})

    # 兜底: 未知档位 (StrEnum 不会走到这里)
    raise TrustModeSwitchRefused(
        target=target, reasons=[f"未知 trust_mode: {target!r}"]
    )
