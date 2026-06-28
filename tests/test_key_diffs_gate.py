"""key-diffs 硬 gate 测试 (design §2.3)."""
from __future__ import annotations

import pytest

from loop_engineering.checklists.key_diffs_gate import (
    GateStatus,
    KeyDiffsGateResult,
    all_hard_gates_pass,
    is_hard_gate_task,
    validate_key_diffs_submission,
    validate_many,
)
from loop_engineering.schema.artifacts import KeyDiffEntry, KeyDiffsFile
from loop_engineering.schema.task_plan import RiskLevel, Task


def _make_task(
    task_id: str = "t1",
    *,
    risk: RiskLevel = RiskLevel.normal,
    exclusive: bool = False,
) -> Task:
    return Task(
        id=task_id,
        title=f"title for {task_id}",
        allowed_write_paths=["src/"],
        acceptance_refs=["AC-1"],
        risk=risk,
        exclusive=exclusive,
    )


def _make_key_diffs(task_id: str = "t1", *, n: int = 1) -> KeyDiffsFile:
    return KeyDiffsFile(
        task_id=task_id,
        key_diffs=[
            KeyDiffEntry(
                file=f"src/file{i}.py",
                change=f"change {i}",
                why=f"why {i}",
                risk=f"risk {i}",
            )
            for i in range(n)
        ],
    )


# ---------------------------------------------------------------------------
# is_hard_gate_task
# ---------------------------------------------------------------------------

class TestIsHardGate:
    def test_is_hard_gate_high_risk(self) -> None:
        assert is_hard_gate_task(_make_task(risk=RiskLevel.high)) is True

    def test_is_hard_gate_exclusive(self) -> None:
        assert is_hard_gate_task(_make_task(exclusive=True)) is True

    def test_is_hard_gate_high_risk_and_exclusive(self) -> None:
        assert is_hard_gate_task(_make_task(risk=RiskLevel.high, exclusive=True)) is True

    def test_is_hard_gate_normal(self) -> None:
        assert is_hard_gate_task(_make_task(risk=RiskLevel.normal, exclusive=False)) is False


# ---------------------------------------------------------------------------
# validate_key_diffs_submission
# ---------------------------------------------------------------------------

class TestValidateSubmission:
    def test_validate_hard_gate_pass(self) -> None:
        t = _make_task(risk=RiskLevel.high)
        r = validate_key_diffs_submission(t, _make_key_diffs(n=2))
        assert r.status == GateStatus.PASS
        assert r.task_id == "t1"
        assert "2 条" in r.reason

    def test_validate_hard_gate_pass_exclusive(self) -> None:
        t = _make_task(exclusive=True)
        r = validate_key_diffs_submission(t, _make_key_diffs())
        assert r.status == GateStatus.PASS

    def test_validate_hard_gate_missing_file(self) -> None:
        t = _make_task(risk=RiskLevel.high)
        r = validate_key_diffs_submission(t, None)
        assert r.status == GateStatus.FAIL
        assert "硬 gate" in r.reason or "缺" in r.reason

    def test_validate_hard_gate_missing_file_with_raw_text(self) -> None:
        t = _make_task(risk=RiskLevel.high)
        r = validate_key_diffs_submission(t, None, raw_yaml_text="corrupted: [unterminated")
        assert r.status == GateStatus.FAIL
        # 诊断富化: 包含原始片段
        assert "corrupted" in r.reason or "raw_yaml_text" in r.reason

    def test_validate_hard_gate_empty_diffs(self) -> None:
        t = _make_task(risk=RiskLevel.high)
        r = validate_key_diffs_submission(t, _make_key_diffs(n=0))
        assert r.status == GateStatus.FAIL
        assert "空" in r.reason

    def test_validate_normal_task_pass_with_diffs(self) -> None:
        t = _make_task()  # normal, non-exclusive
        r = validate_key_diffs_submission(t, _make_key_diffs())
        assert r.status == GateStatus.PASS

    def test_validate_normal_task_soft_without_diffs(self) -> None:
        t = _make_task()
        r = validate_key_diffs_submission(t, None)
        assert r.status == GateStatus.SOFT
        assert "软约束" in r.reason

    def test_validate_normal_task_soft_with_empty_diffs(self) -> None:
        t = _make_task()
        r = validate_key_diffs_submission(t, _make_key_diffs(n=0))
        assert r.status == GateStatus.SOFT


# ---------------------------------------------------------------------------
# validate_many
# ---------------------------------------------------------------------------

class TestValidateMany:
    def test_validate_many_mixed(self) -> None:
        tasks = [
            _make_task("t-high", risk=RiskLevel.high),
            _make_task("t-excl", exclusive=True),
            _make_task("t-normal"),
        ]
        kd = {
            "t-high": _make_key_diffs("t-high"),
            "t-excl": None,  # FAIL
            "t-normal": None,  # SOFT
        }
        results = validate_many(tasks, kd)
        assert len(results) == 3
        by_id = {r.task_id: r for r in results}
        assert by_id["t-high"].status == GateStatus.PASS
        assert by_id["t-excl"].status == GateStatus.FAIL
        assert by_id["t-normal"].status == GateStatus.SOFT

    def test_validate_many_returns_in_order(self) -> None:
        tasks = [_make_task("t1"), _make_task("t2"), _make_task("t3")]
        kd = {"t1": None, "t2": None, "t3": None}
        results = validate_many(tasks, kd)
        assert [r.task_id for r in results] == ["t1", "t2", "t3"]

    def test_validate_many_all_must_pass_for_complete(self) -> None:
        """helper: 一 task FAIL 则整体不能 COMPLETE."""
        # 全过
        tasks_ok = [_make_task("t-high", risk=RiskLevel.high)]
        kd_ok = {"t-high": _make_key_diffs("t-high")}
        results_ok = validate_many(tasks_ok, kd_ok)
        assert all_hard_gates_pass(results_ok) is True

        # 任一 FAIL
        tasks_fail = [
            _make_task("t-high-1", risk=RiskLevel.high),
            _make_task("t-high-2", risk=RiskLevel.high),
        ]
        kd_fail = {
            "t-high-1": _make_key_diffs("t-high-1"),
            "t-high-2": None,  # FAIL
        }
        results_fail = validate_many(tasks_fail, kd_fail)
        assert all_hard_gates_pass(results_fail) is False

    def test_validate_many_soft_does_not_block(self) -> None:
        """SOFT 状态不阻断 (普通 task 缺文件不阻断 COMPLETE)."""
        tasks = [_make_task("t-normal")]
        kd = {"t-normal": None}
        results = validate_many(tasks, kd)
        assert results[0].status == GateStatus.SOFT
        assert all_hard_gates_pass(results) is True


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
