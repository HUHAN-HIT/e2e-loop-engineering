"""任务计划模型 (task-plan.yaml).

规范源: design §3.1 (极简 task-plan + checks 文法)、§3.2 (task.status 四态)、
§11.1 (多服务 task 字段).

schema 层只校验结构, 不解析 checks 文法 (那是 checklists 模块的事).
"""
from __future__ import annotations

from enum import StrEnum
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, ConfigDict, Field

from .run_state import Complexity


class TaskStatus(StrEnum):
    """task.status 四态 (design §3.2).

    pending: 可被 ready_frontier 选中.
    running: worker 已派出、尚未交回.
    blocked: watchdog 二次回收或自检两次失败后由人接手, 永不选中.
    complete: worker 交回且自检通过.
    """

    pending = "pending"
    running = "running"
    blocked = "blocked"
    complete = "complete"


class RiskLevel(StrEnum):
    """task 风险等级 (design §3.1).

    high = 控制面核心/安全/数据迁移/不可逆操作; high 在收口前自动触发红队 (§4).
    """

    normal = "normal"
    high = "high"


class TestCase(BaseModel):
    """单个测试用例 (design §3.1).

    checks 是文法字符串列表 (lhs op rhs), 由 checklists 模块机械求值,
    schema 层不解析内容, 只保证是字符串列表.
    """

    # 跳过 pytest 收集 (类名以 Test 开头会被误认为测试类)
    __test__ = False

    id: str
    scenario: str
    checks: list[str]


class Task(BaseModel):
    """单个 task (design §3.1 / §11.1).

    单服务 run 不填 service / provides_contracts / consumes_contracts.
    """

    id: str
    title: str
    allowed_write_paths: list[str]
    acceptance_refs: list[str]
    depends_on: list[str] = []
    exclusive: bool = False
    risk: RiskLevel = RiskLevel.normal
    tests: list[TestCase] = []
    status: TaskStatus = TaskStatus.pending
    attempt: int = 0
    # 多服务可选 (design §11.1)
    service: str | None = None
    provides_contracts: list[str] = []
    consumes_contracts: list[str] = []


class TaskPlan(BaseModel):
    """task-plan.yaml 顶层模型 (design §3.1).

    schema 字段在 Python 侧用 `schema_` (因 `schema` 是 pydantic 保留方法名),
    序列化时用 alias 还原为 `schema`. 构造时 schema_ 或 schema 二者皆可.
    """

    model_config = ConfigDict(populate_by_name=True)

    schema_: str = Field(default="loop-engineering.task-plan.v2", alias="schema")
    complexity: Complexity
    tasks: list[Task]

    def to_yaml_file(self, path: Path) -> None:
        """序列化到 task-plan.yaml.

        用 mode="json" 把 StrEnum 等转成原生 str, 否则 yaml.safe_dump 不识别.
        """
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        data = self.model_dump(by_alias=True, exclude_none=False, mode="json")
        path.write_text(
            yaml.safe_dump(data, sort_keys=False, allow_unicode=True),
            encoding="utf-8",
        )

    @classmethod
    def from_yaml_file(cls, path: Path) -> "TaskPlan":
        """从 task-plan.yaml 反序列化."""
        data = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
        return cls.model_validate(data)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TaskPlan":
        """从字典构造."""
        return cls.model_validate(data)
