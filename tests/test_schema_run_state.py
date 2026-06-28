"""tests for loop_engineering.schema.run_state."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from loop_engineering.schema.run_state import (
    HumanPending,
    Phase,
    RunCapabilities,
    RunConfig,
    RunState,
    TrustMode,
    WatchdogTimeouts,
)


def test_phase_enum_values() -> None:
    """7 个 phase 值与 design §6 一致."""
    assert Phase.CREATED.value == "CREATED"
    assert Phase.CLARIFYING.value == "CLARIFYING"
    assert Phase.PLANNING.value == "PLANNING"
    assert Phase.IMPLEMENTING.value == "IMPLEMENTING"
    assert Phase.WRAPPING_UP.value == "WRAPPING_UP"
    assert Phase.COMPLETE.value == "COMPLETE"
    assert Phase.ABORTED.value == "ABORTED"
    assert len(list(Phase)) == 7


def test_run_state_minimal() -> None:
    """最小 run-state: run_id + complexity 必填, 其他默认."""
    rs = RunState(run_id="20260627-001", complexity="complex")
    assert rs.run_id == "20260627-001"
    assert rs.phase == Phase.CREATED
    assert rs.complexity.value == "complex"
    assert rs.trust_mode == TrustMode.collaborative
    assert rs.human_pending is None
    assert rs.active_tasks == []
    assert rs.key_artifacts == []
    assert rs.capabilities is None
    assert isinstance(rs.config, RunConfig)
    assert rs.aborted_at is None
    assert rs.aborted_reason is None


def test_run_state_aborted_requires_aborted_at() -> None:
    """phase=ABORTED 但 aborted_at=None → ValidationError (design §8.1)."""
    with pytest.raises(ValidationError) as exc_info:
        RunState(
            run_id="r1",
            complexity="simple",
            phase=Phase.ABORTED,
            aborted_at=None,
            aborted_reason="环境异常",
        )
    assert "aborted_at" in str(exc_info.value)


def test_run_state_aborted_ok_with_aborted_at() -> None:
    """phase=ABORTED 且 aborted_at 提供 → 合法."""
    rs = RunState(
        run_id="r1",
        complexity="simple",
        phase=Phase.ABORTED,
        aborted_at="2026-06-27T10:00:00Z",
        aborted_reason="环境异常",
    )
    assert rs.aborted_at == "2026-06-27T10:00:00Z"


def test_run_state_non_aborted_forbids_aborted_at() -> None:
    """phase != ABORTED 时 aborted_at 设置 → ValidationError (design §6)."""
    with pytest.raises(ValidationError) as exc_info:
        RunState(
            run_id="r1",
            complexity="simple",
            phase=Phase.IMPLEMENTING,
            aborted_at="2026-06-27T10:00:00Z",
            aborted_reason=None,
        )
    msg = str(exc_info.value)
    assert "aborted_at" in msg or "ABORTED" in msg


def test_run_state_non_aborted_forbids_aborted_reason() -> None:
    """phase != ABORTED 时 aborted_reason 单独设置 → ValidationError."""
    with pytest.raises(ValidationError):
        RunState(
            run_id="r1",
            complexity="simple",
            phase=Phase.IMPLEMENTING,
            aborted_at=None,
            aborted_reason="某种描述",
        )


def test_run_state_json_roundtrip(tmp_path: Path) -> None:
    """to_json_file → from_json_file 往返一致."""
    rs = RunState(
        run_id="20260627-001",
        complexity="complex",
        phase=Phase.IMPLEMENTING,
        human_pending=None,
        active_tasks=["T02", "T03"],
        key_artifacts=["planning/design.md", "planning/task-plan.yaml"],
        capabilities=RunCapabilities(git_diff=True, fs_snapshot=True),
        config=RunConfig(
            watchdog_timeout_min=WatchdogTimeouts(),
            max_retries_per_task=1,
            max_concurrency=4,
        ),
    )
    out = tmp_path / "run-state.json"
    rs.to_json_file(out)
    assert out.exists()
    # 重新读回
    rs2 = RunState.from_json_file(out)
    assert rs2.run_id == rs.run_id
    assert rs2.phase == rs.phase
    assert rs2.complexity == rs.complexity
    assert rs2.active_tasks == rs.active_tasks
    assert rs2.key_artifacts == rs.key_artifacts
    assert rs2.capabilities == rs.capabilities
    assert rs2.config == rs.config
    assert rs2.aborted_at is None


def test_human_pending_optional() -> None:
    """human_pending 默认 None (design §6)."""
    rs = RunState(run_id="r1", complexity="medium")
    assert rs.human_pending is None
    # 也能设置成各类非空值
    for v in (
        HumanPending.clarification,
        HumanPending.plan_signoff,
        HumanPending.wrap_up_signoff,
    ):
        rs2 = RunState(run_id="r1", complexity="medium", human_pending=v)
        assert rs2.human_pending == v


def test_run_state_json_excludes_none_when_serialized(tmp_path: Path) -> None:
    """非 ABORTED 时序列化产物不含 aborted_at/aborted_reason 字段 (避免误导)."""
    rs = RunState(run_id="r1", complexity="simple")
    out = tmp_path / "run-state.json"
    rs.to_json_file(out)
    raw = json.loads(out.read_text(encoding="utf-8"))
    assert "aborted_at" not in raw
    assert "aborted_reason" not in raw
