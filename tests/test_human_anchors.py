"""human_anchors.py 的测试 (design §1, §6)."""
from __future__ import annotations

import pytest

from loop_engineering.schema.run_state import Complexity, HumanPending, Phase, RunState
from loop_engineering.state_machine.human_anchors import (
    InvalidHumanAnchorError,
    awaiting_anchor,
    clear_human_pending,
    is_awaiting_human,
    set_human_pending,
)


def _make(phase: Phase) -> RunState:
    return RunState(run_id="r1", complexity=Complexity.simple, phase=phase)


# ---------- clarification ----------

def test_set_clarification_only_in_created_or_clarifying() -> None:
    """clarification 仅在 CREATED/CLARIFYING 合法."""
    # 合法
    for ok in (Phase.CREATED, Phase.CLARIFYING):
        s = set_human_pending(_make(ok), HumanPending.clarification)
        assert s.human_pending == HumanPending.clarification
    # 非法: IMPLEMENTING
    with pytest.raises(InvalidHumanAnchorError) as exc:
        set_human_pending(_make(Phase.IMPLEMENTING), HumanPending.clarification)
    assert exc.value.phase == Phase.IMPLEMENTING
    assert exc.value.anchor == HumanPending.clarification


# ---------- plan_signoff ----------

def test_set_plan_signoff_only_in_planning() -> None:
    """plan_signoff 仅在 PLANNING 合法."""
    s = set_human_pending(_make(Phase.PLANNING), HumanPending.plan_signoff)
    assert s.human_pending == HumanPending.plan_signoff
    # 非法: CREATED / IMPLEMENTING / WRAPPING_UP
    for bad in (Phase.CREATED, Phase.IMPLEMENTING, Phase.WRAPPING_UP):
        with pytest.raises(InvalidHumanAnchorError):
            set_human_pending(_make(bad), HumanPending.plan_signoff)


# ---------- wrap_up_signoff ----------

def test_set_wrap_up_signoff_only_in_wrapping_up() -> None:
    """wrap_up_signoff 仅在 WRAPPING_UP 合法."""
    s = set_human_pending(_make(Phase.WRAPPING_UP), HumanPending.wrap_up_signoff)
    assert s.human_pending == HumanPending.wrap_up_signoff
    for bad in (Phase.CREATED, Phase.PLANNING, Phase.IMPLEMENTING, Phase.COMPLETE):
        with pytest.raises(InvalidHumanAnchorError):
            set_human_pending(_make(bad), HumanPending.wrap_up_signoff)


# ---------- 不可变 ----------

def test_set_human_pending_returns_new_instance() -> None:
    """set 不修改原 state."""
    state = _make(Phase.PLANNING)
    new_state = set_human_pending(state, HumanPending.plan_signoff)
    assert state.human_pending is None
    assert new_state.human_pending == HumanPending.plan_signoff
    assert state is not new_state


# ---------- clear / query ----------

def test_clear_human_pending() -> None:
    """clear 返回 human_pending=None 的新 state."""
    state = set_human_pending(_make(Phase.PLANNING), HumanPending.plan_signoff)
    cleared = clear_human_pending(state)
    assert state.human_pending == HumanPending.plan_signoff  # 原不变
    assert cleared.human_pending is None
    assert cleared is not state


def test_is_awaiting_human_true_when_set() -> None:
    state = _make(Phase.PLANNING)
    assert is_awaiting_human(state) is False
    waiting = set_human_pending(state, HumanPending.plan_signoff)
    assert is_awaiting_human(waiting) is True
    cleared = clear_human_pending(waiting)
    assert is_awaiting_human(cleared) is False


def test_awaiting_anchor_returns_current() -> None:
    state = _make(Phase.CREATED)
    assert awaiting_anchor(state) is None
    waiting = set_human_pending(state, HumanPending.clarification)
    assert awaiting_anchor(waiting) == HumanPending.clarification
