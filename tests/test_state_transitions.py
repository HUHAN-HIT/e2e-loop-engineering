"""transitions.py 的测试 (design §1, §8.1)."""
from __future__ import annotations

from datetime import datetime

import pytest

from loop_engineering.schema.run_state import Complexity, Phase, RunState
from loop_engineering.state_machine.transitions import (
    LEGAL_TRANSITIONS,
    IllegalTransitionError,
    advance_phase,
    can_transition,
    is_terminal,
    validate_transition,
)


# ---------- 辅助 ----------

def _make(phase: Phase = Phase.CREATED) -> RunState:
    """构造指定 phase 的最小 RunState."""
    return RunState(run_id="r1", complexity=Complexity.simple, phase=phase)


# ---------- graph 覆盖 ----------

def test_legal_transitions_complete_graph() -> None:
    """LEGAL_TRANSITIONS 必须覆盖全部 7 个 Phase."""
    assert set(LEGAL_TRANSITIONS.keys()) == set(Phase)


def test_every_non_terminal_can_abort() -> None:
    """5 个非终态都能转 ABORTED (§8.1)."""
    non_terminal = {
        Phase.CREATED,
        Phase.CLARIFYING,
        Phase.PLANNING,
        Phase.IMPLEMENTING,
        Phase.WRAPPING_UP,
    }
    for p in non_terminal:
        assert Phase.ABORTED in LEGAL_TRANSITIONS[p], f"{p} 必须能转 ABORTED"


def test_terminal_phases_have_no_outgoing() -> None:
    """COMPLETE / ABORTED 是终态, 无后继 (§8 / §8.1)."""
    assert LEGAL_TRANSITIONS[Phase.COMPLETE] == frozenset()
    assert LEGAL_TRANSITIONS[Phase.ABORTED] == frozenset()


def test_clarifying_can_be_skipped() -> None:
    """CREATED → PLANNING 直接合法 (CLARIFYING 可跳过, §1)."""
    assert can_transition(Phase.CREATED, Phase.PLANNING)


def test_planning_self_loop() -> None:
    """PLANNING → PLANNING 合法 (plan-amendment 回到 PLANNING 重审, §1)."""
    assert can_transition(Phase.PLANNING, Phase.PLANNING)


# ---------- 非法迁移 ----------

def test_illegal_transition_raises() -> None:
    """终态后任何迁移都非法."""
    for terminal in (Phase.COMPLETE, Phase.ABORTED):
        for target in Phase:
            with pytest.raises(IllegalTransitionError) as exc:
                validate_transition(terminal, target)
            assert exc.value.current == terminal
            assert exc.value.target == target
            assert exc.value.legal_targets == frozenset()


def test_illegal_transition_created_to_wrapping() -> None:
    """跨阶段跳迁非法 (CREATED 不能直接 WRAPPING_UP)."""
    with pytest.raises(IllegalTransitionError):
        validate_transition(Phase.CREATED, Phase.WRAPPING_UP)


# ---------- advance_phase ----------

def test_advance_phase_returns_new_instance() -> None:
    """advance 不修改原 state (pydantic model_copy 不可变风格)."""
    state = _make(Phase.CREATED)
    original_phase = state.phase
    new_state = advance_phase(state, Phase.CLARIFYING)
    # 原状态不变
    assert state.phase == original_phase
    assert state is not new_state
    # 新状态推进
    assert new_state.phase == Phase.CLARIFYING


def test_advance_to_aborted_sets_timestamp() -> None:
    """进 ABORTED 写 ISO 8601 非空时间戳."""
    state = _make(Phase.CREATED)
    new_state = advance_phase(state, Phase.ABORTED, aborted_reason="用户放弃")
    assert new_state.phase == Phase.ABORTED
    assert new_state.aborted_at is not None
    # ISO 8601 可被 fromisoformat 解析, 且带时区
    ts = datetime.fromisoformat(new_state.aborted_at)
    assert ts.tzinfo is not None
    assert new_state.aborted_reason == "用户放弃"


def test_advance_to_aborted_requires_reason() -> None:
    """进 ABORTED 必须给 reason (§8.1)."""
    state = _make(Phase.CREATED)
    with pytest.raises(ValueError):
        advance_phase(state, Phase.ABORTED, aborted_reason=None)
    # 空字符串也视为未提供
    with pytest.raises(ValueError):
        advance_phase(state, Phase.ABORTED, aborted_reason="")


def test_advance_to_aborted_from_every_phase() -> None:
    """5 个非终态都能转 ABORTED."""
    for p in (
        Phase.CREATED,
        Phase.CLARIFYING,
        Phase.PLANNING,
        Phase.IMPLEMENTING,
        Phase.WRAPPING_UP,
    ):
        state = _make(p)
        new_state = advance_phase(state, Phase.ABORTED, aborted_reason="放弃")
        assert new_state.phase == Phase.ABORTED
        assert new_state.aborted_at is not None


def test_advance_clears_aborted_fields_on_non_aborted() -> None:
    """防御性: 进非 ABORTED 时 aborted_at / aborted_reason 必须为 None.

    构造一个原本带着 (不可能但模拟) 残留的状态进 ABORTED 再退回非终态不方便,
    这里直接验证 advance 到非 ABORTED 目标的字段为 None.
    """
    state = _make(Phase.CREATED)
    new_state = advance_phase(state, Phase.PLANNING)
    assert new_state.aborted_at is None
    assert new_state.aborted_reason is None


def test_advance_illegal_raises() -> None:
    """advance 内部调用 validate, 非法时 raise."""
    state = _make(Phase.COMPLETE)
    with pytest.raises(IllegalTransitionError):
        advance_phase(state, Phase.PLANNING)


# ---------- is_terminal ----------

def test_is_terminal() -> None:
    assert is_terminal(Phase.COMPLETE)
    assert is_terminal(Phase.ABORTED)
    for p in (
        Phase.CREATED,
        Phase.CLARIFYING,
        Phase.PLANNING,
        Phase.IMPLEMENTING,
        Phase.WRAPPING_UP,
    ):
        assert not is_terminal(p)
