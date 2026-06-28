"""§5 trust_mode 切档 gate 测试."""
from __future__ import annotations

import pytest

from loop_engineering.schema.run_state import Complexity, RunState, TrustMode
from loop_engineering.trust_mode import gate as gate_module
from loop_engineering.trust_mode.gate import (
    TrustModeSwitchRefused,
    can_switch_to_unattended,
    probe_unattended_readiness,
    switch_trust_mode,
)


def _mk_state(mode: TrustMode = TrustMode.collaborative) -> RunState:
    return RunState(run_id="r1", complexity=Complexity.medium, trust_mode=mode)


class TestProbe:
    def test_default_returns_false(self) -> None:
        r = probe_unattended_readiness()
        assert r.independent_replay_channel_ready is False
        assert r.reasons  # 非空

    def test_can_switch_to_unattended_false_by_default(self) -> None:
        r = probe_unattended_readiness()
        assert can_switch_to_unattended(r) is False


class TestSwitchToCollaborative:
    def test_always_allowed_from_unattended(self) -> None:
        state = _mk_state(TrustMode.unattended)
        new_state = switch_trust_mode(state, TrustMode.collaborative)
        assert new_state.trust_mode == TrustMode.collaborative
        # 原状态未变
        assert state.trust_mode == TrustMode.unattended

    def test_idempotent(self) -> None:
        state = _mk_state(TrustMode.collaborative)
        new_state = switch_trust_mode(state, TrustMode.collaborative)
        assert new_state.trust_mode == TrustMode.collaborative


class TestSwitchToUnattended:
    def test_refused_when_not_ready(self) -> None:
        state = _mk_state(TrustMode.collaborative)
        with pytest.raises(TrustModeSwitchRefused) as exc_info:
            switch_trust_mode(state, TrustMode.unattended)
        assert exc_info.value.target == TrustMode.unattended
        assert exc_info.value.reasons  # 非空

    def test_allowed_when_ready(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # monkeypatch probe 返回 True
        monkeypatch.setattr(
            gate_module,
            "probe_unattended_readiness",
            lambda: gate_module.UnattendedReadiness(
                independent_replay_channel_ready=True, reasons=[]
            ),
        )
        state = _mk_state(TrustMode.collaborative)
        new_state = switch_trust_mode(state, TrustMode.unattended)
        assert new_state.trust_mode == TrustMode.unattended

    def test_returns_new_instance_not_mutating_original(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            gate_module,
            "probe_unattended_readiness",
            lambda: gate_module.UnattendedReadiness(
                independent_replay_channel_ready=True, reasons=[]
            ),
        )
        state = _mk_state(TrustMode.collaborative)
        new_state = switch_trust_mode(state, TrustMode.unattended)
        assert new_state is not state
        assert state.trust_mode == TrustMode.collaborative  # 原未改
        assert new_state.trust_mode == TrustMode.unattended
