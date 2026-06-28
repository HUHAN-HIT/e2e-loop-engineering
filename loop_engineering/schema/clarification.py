"""澄清问题模型 (CLARIFYING phase, 多数 run 跳过).

规范源: design §1 (主流程: CLARIFYING 仅当有阻塞性歧义)、§6 (clarification/ 目录).
"""
from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Question(BaseModel):
    """单个阻塞性澄清问题 (design §1, §6).

    四字段均不得为空字符串 —— 澄清问题必填实质内容,
    而非"这个你想要吗?"这类无信息问题.
    """

    id: str
    question: str
    why_blocking: str
    default_if_unanswered: str

    @model_validator(mode="after")
    def _require_non_empty(self) -> "Question":
        """四字段均不得为空字符串."""
        for name in ("question", "why_blocking", "default_if_unanswered"):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(
                    f"Question.{name} 不得为空字符串 (design: 澄清问题必填实质内容)"
                )
        return self


class ClarificationQuestions(BaseModel):
    """clarification/questions.json 模型 (design §6).

    simple 档可整段跳过 (questions=[] 且 can_proceed_with_defaults=True).
    """

    model_config = ConfigDict(populate_by_name=True)

    schema_: str = Field(default="loop-engineering.clarification.v2", alias="schema")
    questions: list[Question] = []
    can_proceed_with_defaults: bool = True

    def to_json_file(self, path: Path) -> None:
        """序列化到 questions.json."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            self.model_dump_json(by_alias=True, exclude_none=True, indent=2),
            encoding="utf-8",
        )

    @classmethod
    def from_json_file(cls, path: Path) -> "ClarificationQuestions":
        """从 questions.json 反序列化."""
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls.model_validate(data)


class ClarificationAnswers(BaseModel):
    """clarification/answers.json 模型 (design §6).

    answers: question_id → 人答 / "采用默认".
    人不答则由 coordinator 写入 "采用默认".
    """

    model_config = ConfigDict(populate_by_name=True)

    schema_: str = Field(
        default="loop-engineering.clarification-answers.v1", alias="schema"
    )
    answers: dict[str, str] = {}
