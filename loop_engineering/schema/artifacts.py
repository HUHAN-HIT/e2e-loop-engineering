"""worker 产物 schema.

规范源: design §0.2 (worker 自报告软约束)、§0.4 (artifact-first)、
§2.3 (key-diffs.yaml 分级)、§3.1 (test-results.yaml 固定字段)、§3.6 (plan-amendment).

关键约束: test-results 用 extra="forbid" 强制 worker 不得自创字段 (§3.1).
"""
from __future__ import annotations

import warnings
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, model_validator


class TestCaseResult(BaseModel):
    """worker 跑单测后某个 case 的结果 (design §3.1).

    extra="forbid" 强制: worker 不得自创字段去迎合某条 checks
    (那等于让被测方定义判定口径, hallucination 落点).
    """

    # 跳过 pytest 收集 (类名以 Test 开头会被误认为测试类)
    __test__ = False

    model_config = ConfigDict(extra="forbid")

    id: str
    passed: bool
    failure_reason: str = ""


class TestResults(BaseModel):
    """test-results.yaml 模型 (design §3.1).

    extra="forbid": worker 不得自创字段.
    tests_green 是 worker 自报告的总开关, 与 cases.passed 一致性是软约束
    (design §0.2: 自报告被接受, hallucination 兜底靠收口 diff, 不在 schema 强制).
    """

    # 跳过 pytest 收集
    __test__ = False

    model_config = ConfigDict(extra="forbid")

    tests_green: bool
    cases: list[TestCaseResult]

    @model_validator(mode="after")
    def _check_consistency(self) -> "TestResults":
        """tests_green 与 cases.passed 不一致时告警但不 raise (软约束)."""
        if self.cases:
            consistent = self.tests_green == all(c.passed for c in self.cases)
        else:
            consistent = self.tests_green is False or self.tests_green is True
        # 空 cases 时, 约定 tests_green=False 表示无测试; True 也接受 (worker 声称无需测试)
        if self.cases and not consistent:
            warnings.warn(
                f"test-results.yaml: tests_green={self.tests_green} 与 cases.passed 不一致 "
                f"(design §0.2 软约束, worker 自报告)",
                stacklevel=2,
            )
        return self


class KeyDiffEntry(BaseModel):
    """单条关键改动 (design §2.3).

    risk 这里是 worker 自由文本描述该条改动的风险点, 区别于 task.risk (枚举).
    """

    file: str
    change: str
    why: str
    risk: str


class KeyDiffsFile(BaseModel):
    """key-diffs.yaml 模型 (design §2.3, §6).

    risk:high / exclusive task 收口前必填非空 (§2.3); 非空判定用 is_meaningful().
    """

    model_config = ConfigDict(populate_by_name=True)

    schema_: str = Field(default="loop-engineering.key-diffs.v1", alias="schema")
    task_id: str
    key_diffs: list[KeyDiffEntry] = []

    @classmethod
    def from_yaml_file(cls, path: Path) -> "KeyDiffsFile":
        """从 key-diffs.yaml 反序列化."""
        data = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
        return cls.model_validate(data)

    def is_meaningful(self) -> bool:
        """是否非空 (design §2.3: risk:high/exclusive task 的 key_diffs 必填非空)."""
        return len(self.key_diffs) > 0

    def to_yaml_file(self, path: Path) -> None:
        """序列化到 key-diffs.yaml. 用 mode="json" 退枚举."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        data = self.model_dump(by_alias=True, exclude_none=False, mode="json")
        path.write_text(
            yaml.safe_dump(data, sort_keys=False, allow_unicode=True),
            encoding="utf-8",
        )


class PlanAmendmentNeeded(BaseModel):
    """plan-amendment 信号 (design §3.6).

    worker 发现某 planned 用例不可执行或本身错了, 返回此结构.
    touched_acceptance_refs 必须非空 (amendment 必须声明触及的 AC).
    """

    status: Literal["plan-amendment-needed"] = "plan-amendment-needed"
    reason: str
    touched_acceptance_refs: list[str]

    @model_validator(mode="after")
    def _require_touched_refs(self) -> "PlanAmendmentNeeded":
        """amendment 必须声明触及的 AC (design §3.6)."""
        if len(self.touched_acceptance_refs) < 1:
            raise ValueError(
                "touched_acceptance_refs 不得为空 (design §3.6: amendment 必须声明触及的 AC)"
            )
        return self


class ContractChange(BaseModel):
    """worker 在 summary 里声明的契约变更引用 (design §11.2 第 2 层).

    辅助及早信号; 与权威触发源 (service-contracts.yaml 版本 diff) 不一致时以权威为准 + 告警.
    """

    name: str
