"""tests for loop_engineering.schema.artifacts."""
from __future__ import annotations

import warnings
from pathlib import Path

import pytest
from pydantic import ValidationError

from loop_engineering.schema.artifacts import (
    ContractChange,
    KeyDiffEntry,
    KeyDiffsFile,
    PlanAmendmentNeeded,
    TestCaseResult,
    TestResults,
)


def test_test_case_result_extra_forbidden() -> None:
    """TestCaseResult 传未知字段 → ValidationError (design §3.1 关键约束)."""
    with pytest.raises(ValidationError) as exc_info:
        TestCaseResult(id="C1", passed=True, foo="bar")  # type: ignore[call-arg]
    assert "foo" in str(exc_info.value)


def test_test_case_result_ok() -> None:
    """合法 case result."""
    r = TestCaseResult(id="C1", passed=True, failure_reason="")
    assert r.passed is True
    r2 = TestCaseResult(id="C2", passed=False, failure_reason="assertion failed")
    assert r2.failure_reason == "assertion failed"


def test_test_results_extra_forbidden() -> None:
    """TestResults 传未知字段 → ValidationError (design §3.1)."""
    with pytest.raises(ValidationError):
        TestResults(  # type: ignore[call-arg]
            tests_green=True,
            cases=[],
            bogus_field=1,
        )


def test_test_results_consistency_warning() -> None:
    """tests_green 与 cases.passed 不一致 → warn 但不 raise (design §0.2 软约束)."""
    with pytest.warns(UserWarning):
        TestResults(
            tests_green=True,
            cases=[
                TestCaseResult(id="C1", passed=False, failure_reason="fail"),
            ],
        )
    # 一致时不 warn
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        TestResults(
            tests_green=False,
            cases=[TestCaseResult(id="C1", passed=False)],
        )


def test_key_diffs_file_is_meaningful() -> None:
    """空 key_diffs → False; 非空 → True (design §2.3)."""
    empty = KeyDiffsFile(task_id="T01", key_diffs=[])
    assert empty.is_meaningful() is False
    non_empty = KeyDiffsFile(
        task_id="T01",
        key_diffs=[
            KeyDiffEntry(
                file="src/x.py",
                change="新增校验",
                why="实现 AC-001",
                risk="无",
            )
        ],
    )
    assert non_empty.is_meaningful() is True


def test_plan_amendment_requires_touched_refs() -> None:
    """touched_acceptance_refs=[] → ValidationError (design §3.6)."""
    with pytest.raises(ValidationError) as exc_info:
        PlanAmendmentNeeded(
            reason="用例不可执行",
            touched_acceptance_refs=[],
        )
    assert "touched_acceptance_refs" in str(exc_info.value)


def test_plan_amendment_ok() -> None:
    """合法 amendment."""
    a = PlanAmendmentNeeded(
        reason="T01-CASE-002 假设不成立",
        touched_acceptance_refs=["AC-002"],
    )
    assert a.status == "plan-amendment-needed"


def test_key_diffs_yaml_roundtrip(tmp_path: Path) -> None:
    """key-diffs.yaml 往返一致."""
    f = KeyDiffsFile(
        task_id="T01",
        key_diffs=[
            KeyDiffEntry(
                file="src/auth.py",
                change="加 token 校验",
                why="实现 AC-007",
                risk="影响登录路径",
            )
        ],
    )
    out = tmp_path / "key-diffs.yaml"
    f.to_yaml_file(out)
    f2 = KeyDiffsFile.from_yaml_file(out)
    assert f2.task_id == "T01"
    assert len(f2.key_diffs) == 1
    assert f2.key_diffs[0].file == "src/auth.py"
    assert f2.key_diffs[0].risk == "影响登录路径"
    assert f2.schema_ == "loop-engineering.key-diffs.v1"


def test_contract_change_name_field() -> None:
    """ContractChange 只携带 contract id 引用 (design §11.2)."""
    cc = ContractChange(name="C-auth-token")
    assert cc.name == "C-auth-token"
