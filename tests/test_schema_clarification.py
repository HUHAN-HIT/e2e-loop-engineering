"""tests for loop_engineering.schema.clarification."""
from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from loop_engineering.schema.clarification import (
    ClarificationAnswers,
    ClarificationQuestions,
    Question,
)


def test_question_requires_non_empty_fields() -> None:
    """Question 的 question / why_blocking / default_if_unanswered 不得为空字符串."""
    # question 空
    with pytest.raises(ValidationError):
        Question(
            id="Q1",
            question="   ",
            why_blocking="阻塞",
            default_if_unanswered="采用 X",
        )
    # why_blocking 空
    with pytest.raises(ValidationError):
        Question(
            id="Q1",
            question="用 A 还是 B?",
            why_blocking="",
            default_if_unanswered="采用 A",
        )
    # default_if_unanswered 空
    with pytest.raises(ValidationError):
        Question(
            id="Q1",
            question="用 A 还是 B?",
            why_blocking="阻塞选型",
            default_if_unanswered="",
        )


def test_question_ok() -> None:
    """合法 Question."""
    q = Question(
        id="Q1",
        question="需要支持多租户吗?",
        why_blocking="影响数据模型选型",
        default_if_unanswered="单租户",
    )
    assert q.id == "Q1"


def test_clarification_questions_empty_ok() -> None:
    """questions=[] 且 can_proceed_with_defaults=True (simple 档跳过澄清)."""
    cq = ClarificationQuestions(questions=[])
    assert cq.questions == []
    assert cq.can_proceed_with_defaults is True
    assert cq.schema_ == "loop-engineering.clarification.v2"


def test_clarification_json_roundtrip(tmp_path: Path) -> None:
    """questions.json 往返一致."""
    cq = ClarificationQuestions(
        questions=[
            Question(
                id="Q1",
                question="需要多租户?",
                why_blocking="影响数据模型",
                default_if_unanswered="单租户",
            ),
            Question(
                id="Q2",
                question="异步还是同步?",
                why_blocking="影响接口形态",
                default_if_unanswered="同步",
            ),
        ],
        can_proceed_with_defaults=False,
    )
    out = tmp_path / "questions.json"
    cq.to_json_file(out)
    cq2 = ClarificationQuestions.from_json_file(out)
    assert len(cq2.questions) == 2
    assert cq2.questions[0].id == "Q1"
    assert cq2.questions[1].default_if_unanswered == "同步"
    assert cq2.can_proceed_with_defaults is False
    # 序列化字段名为 schema (alias), 不是 schema_
    import json

    raw = json.loads(out.read_text(encoding="utf-8"))
    assert "schema" in raw
    assert raw["schema"] == "loop-engineering.clarification.v2"
    assert "schema_" not in raw


def test_clarification_answers_default_empty() -> None:
    """ClarificationAnswers.answers 默认空 dict."""
    a = ClarificationAnswers()
    assert a.answers == {}
    a2 = ClarificationAnswers(answers={"Q1": "采用默认", "Q2": "多租户"})
    assert a2.answers["Q1"] == "采用默认"
    assert a2.schema_ == "loop-engineering.clarification-answers.v1"
