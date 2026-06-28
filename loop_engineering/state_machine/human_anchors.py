"""人介入锚点 (design §1, §6).

三类人盯点: clarification / plan_signoff / wrap_up_signoff.
状态机只校验 anchor 与当前 phase 的合法性, 不负责通知或超时.
"""
from __future__ import annotations

from ..schema.run_state import HumanPending, Phase, RunState


class InvalidHumanAnchorError(ValueError):
    """anchor 与当前 phase 不匹配 (design §1).

    含 phase / anchor 两字段, 便于上层定位.
    """

    def __init__(self, phase: Phase, anchor: HumanPending) -> None:
        self.phase = phase
        self.anchor = anchor
        super().__init__(
            f"anchor={anchor.value} 在 phase={phase.value} 下不合法 (design §1)"
        )


# design §1: 每个 anchor 只在特定 phase 合法
_ANCHOR_ALLOWED_PHASES: dict[HumanPending, frozenset[Phase]] = {
    HumanPending.clarification: frozenset({Phase.CREATED, Phase.CLARIFYING}),
    HumanPending.plan_signoff: frozenset({Phase.PLANNING}),
    HumanPending.wrap_up_signoff: frozenset({Phase.WRAPPING_UP}),
}


def _validate_anchor(phase: Phase, anchor: HumanPending) -> None:
    allowed = _ANCHOR_ALLOWED_PHASES.get(anchor, frozenset())
    if phase not in allowed:
        raise InvalidHumanAnchorError(phase, anchor)


def set_human_pending(state: RunState, anchor: HumanPending) -> RunState:
    """返回设置了 human_pending=anchor 的新 state.

    校验 anchor 与 phase 合法性, 不合法 raise InvalidHumanAnchorError.
    """
    _validate_anchor(state.phase, anchor)
    return state.model_copy(update={"human_pending": anchor})


def clear_human_pending(state: RunState) -> RunState:
    """返回 human_pending=None 的新 state."""
    return state.model_copy(update={"human_pending": None})


def is_awaiting_human(state: RunState) -> bool:
    """是否正在等人."""
    return state.human_pending is not None


def awaiting_anchor(state: RunState) -> HumanPending | None:
    """返回当前 anchor, 没有则 None."""
    return state.human_pending
