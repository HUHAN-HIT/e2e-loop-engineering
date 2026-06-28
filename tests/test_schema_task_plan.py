"""tests for loop_engineering.schema.task_plan."""
from __future__ import annotations

from pathlib import Path

import yaml
from pydantic import ValidationError

from loop_engineering.schema.task_plan import (
    RiskLevel,
    Task,
    TestCase,
    TaskPlan,
    TaskStatus,
)


def test_task_defaults() -> None:
    """Task 默认值: depends_on=[], exclusive=False, risk=normal, status=pending, attempt=0."""
    t = Task(
        id="T01",
        title="示例",
        allowed_write_paths=["src/**"],
        acceptance_refs=["AC-001"],
    )
    assert t.depends_on == []
    assert t.exclusive is False
    assert t.risk == RiskLevel.normal
    assert t.tests == []
    assert t.status == TaskStatus.pending
    assert t.attempt == 0
    # 多服务字段默认
    assert t.service is None
    assert t.provides_contracts == []
    assert t.consumes_contracts == []


def test_task_plan_yaml_roundtrip(tmp_path: Path) -> None:
    """to_yaml_file → from_yaml_file 往返一致."""
    plan = TaskPlan(
        complexity="complex",
        tasks=[
            Task(
                id="T01",
                title="实现校验",
                allowed_write_paths=["src/clarification/**", "tests/clarification/**"],
                depends_on=[],
                acceptance_refs=["AC-001", "AC-002"],
                exclusive=False,
                risk=RiskLevel.normal,
                tests=[
                    TestCase(
                        id="T01-CASE-001",
                        scenario="合法产物通过校验",
                        checks=["passed == true", "blocked_reasons == []"],
                    ),
                ],
            ),
            Task(
                id="T02",
                title="下游 task",
                allowed_write_paths=["src/downstream/**"],
                depends_on=["T01"],
                acceptance_refs=["AC-003"],
                service="gateway",
                consumes_contracts=["C-auth-token"],
            ),
        ],
    )
    out = tmp_path / "task-plan.yaml"
    plan.to_yaml_file(out)
    plan2 = TaskPlan.from_yaml_file(out)
    assert plan2.complexity == plan.complexity
    assert len(plan2.tasks) == 2
    assert plan2.tasks[0].id == "T01"
    assert plan2.tasks[0].tests[0].checks == ["passed == true", "blocked_reasons == []"]
    assert plan2.tasks[1].service == "gateway"
    assert plan2.tasks[1].consumes_contracts == ["C-auth-token"]


def test_task_plan_alias_schema(tmp_path: Path) -> None:
    """字段名是 `schema` (序列化输出), Python 侧用 `schema_`."""
    plan = TaskPlan(
        complexity="simple",
        tasks=[
            Task(
                id="T01",
                title="t",
                allowed_write_paths=["a/**"],
                acceptance_refs=["AC-001"],
            )
        ],
    )
    # Python 侧访问
    assert plan.schema_ == "loop-engineering.task-plan.v2"
    out = tmp_path / "task-plan.yaml"
    plan.to_yaml_file(out)
    raw = yaml.safe_load(out.read_text(encoding="utf-8"))
    # 序列化输出用的是 alias
    assert "schema" in raw
    assert raw["schema"] == "loop-engineering.task-plan.v2"
    assert "schema_" not in raw


def test_task_plan_populate_by_name() -> None:
    """populate_by_name=True: 构造时 schema_ 或 alias schema 都行."""
    p1 = TaskPlan(
        schema_="loop-engineering.task-plan.v2",
        complexity="simple",
        tasks=[],
    )
    p2 = TaskPlan.model_validate(
        {"schema": "loop-engineering.task-plan.v2", "complexity": "simple", "tasks": []}
    )
    assert p1.schema_ == p2.schema_ == "loop-engineering.task-plan.v2"


def test_test_case_checks_is_list_of_str() -> None:
    """checks 是字符串列表, schema 不解析内容 (design §3.1)."""
    tc = TestCase(
        id="C1",
        scenario="x",
        checks=["passed == true", "'foo' in blocked_reasons", "count >= 1"],
    )
    assert isinstance(tc.checks, list)
    assert all(isinstance(c, str) for c in tc.checks)
    assert tc.checks[1] == "'foo' in blocked_reasons"


def test_task_status_four_states() -> None:
    """task.status 四态 (design §3.2)."""
    assert {s.value for s in TaskStatus} == {"pending", "running", "blocked", "complete"}


def test_task_plan_from_dict() -> None:
    """from_dict 入口."""
    plan = TaskPlan.from_dict(
        {
            "schema": "loop-engineering.task-plan.v2",
            "complexity": "medium",
            "tasks": [],
        }
    )
    assert plan.complexity.value == "medium"


def test_task_plan_invalid_complexity() -> None:
    """非法 complexity → ValidationError."""
    try:
        TaskPlan(complexity="bogus", tasks=[])  # type: ignore[arg-type]
    except ValidationError:
        return
    raise AssertionError("expected ValidationError for bogus complexity")
