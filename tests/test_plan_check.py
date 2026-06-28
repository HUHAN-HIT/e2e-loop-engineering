"""§2.1 计划自检测试 (design §2.1 + §11.2 多服务契约自检)."""
from __future__ import annotations

import pytest

from loop_engineering.checklists.plan_check import check_plan
from loop_engineering.schema.service_contracts import Contract, ServiceContracts
from loop_engineering.schema.task_plan import Task, TaskPlan, TestCase
from loop_engineering.schema.run_state import Complexity


def _mk_task(
    tid: str,
    *,
    refs: list[str] | None = None,
    paths: list[str] | None = None,
    depends_on: list[str] | None = None,
    tests: int = 1,
    service: str | None = None,
    provides: list[str] | None = None,
    consumes: list[str] | None = None,
    exclusive: bool = False,
) -> Task:
    return Task(
        id=tid,
        title=tid,
        allowed_write_paths=paths or [f"src/{tid}/**"],
        acceptance_refs=refs or [f"AC-{tid}"],
        depends_on=depends_on or [],
        tests=[TestCase(id=f"c-{tid}", scenario="s", checks=["passed == true"])] * tests,
        service=service,
        provides_contracts=provides or [],
        consumes_contracts=consumes or [],
        exclusive=exclusive,
    )


def _mk_plan(tasks: list[Task], *, complexity: Complexity = Complexity.simple) -> TaskPlan:
    return TaskPlan(complexity=complexity, tasks=tasks)


class TestAcHasTaskAndTest:
    def test_ac_mapping_pass(self) -> None:
        plan = _mk_plan([_mk_task("T01", refs=["AC-1"], tests=1)])
        result = check_plan(plan)
        # ac_has_task_and_test 各项应全 pass
        ac_items = [i for i in result.items if i.check == "ac_has_task_and_test"]
        assert ac_items and all(i.passed for i in ac_items)

    def test_ac_mapping_fail_when_task_has_no_tests(self) -> None:
        plan = _mk_plan([_mk_task("T01", refs=["AC-1"], tests=0)])
        result = check_plan(plan)
        ac_items = [i for i in result.items if i.check == "ac_has_task_and_test"]
        assert any(not i.passed for i in ac_items)


class TestRequiredFields:
    def test_required_fields_present(self) -> None:
        plan = _mk_plan([_mk_task("T01")])
        result = check_plan(plan)
        field_items = [i for i in result.items if i.check == "task_has_fields"]
        assert all(i.passed for i in field_items)

    def test_required_fields_missing_fails(self) -> None:
        # 缺 acceptance_refs 与 allowed_write_paths
        bad = Task(id="T01", title="t", allowed_write_paths=[], acceptance_refs=[])
        plan = _mk_plan([bad])
        result = check_plan(plan)
        field_items = [i for i in result.items if i.check == "task_has_fields"]
        assert any(not i.passed for i in field_items)


class TestParallelPathsDisjoint:
    def test_disjoint_pass(self) -> None:
        plan = _mk_plan(
            [
                _mk_task("T01", paths=["src/a/**"]),
                _mk_task("T02", paths=["src/b/**"]),
            ]
        )
        # 真实 path_globs_overlap
        from loop_engineering.scheduling.path_overlap import path_globs_overlap

        result = check_plan(plan, path_overlap_fn=path_globs_overlap)
        items = [i for i in result.items if i.check == "parallel_paths_disjoint"]
        assert all(i.passed for i in items)

    def test_disjoint_fail_when_overlap(self) -> None:
        plan = _mk_plan(
            [
                _mk_task("T01", paths=["src/shared/**"]),
                _mk_task("T02", paths=["src/shared/**"]),
            ]
        )
        from loop_engineering.scheduling.path_overlap import path_globs_overlap

        result = check_plan(plan, path_overlap_fn=path_globs_overlap)
        items = [i for i in result.items if i.check == "parallel_paths_disjoint"]
        assert any(not i.passed for i in items)


class TestDepsNoCycle:
    def test_no_cycle_pass(self) -> None:
        plan = _mk_plan(
            [
                _mk_task("T01", depends_on=[]),
                _mk_task("T02", depends_on=["T01"]),
            ]
        )
        result = check_plan(plan)
        items = [i for i in result.items if i.check == "deps_no_cycle"]
        assert items and all(i.passed for i in items)

    def test_cycle_detected(self) -> None:
        plan = _mk_plan(
            [
                _mk_task("T01", depends_on=["T02"]),
                _mk_task("T02", depends_on=["T01"]),
            ]
        )
        result = check_plan(plan)
        items = [i for i in result.items if i.check == "deps_no_cycle"]
        assert items and not items[0].passed


class TestContractsCheck:
    def test_contracts_check_skipped_when_none(self) -> None:
        plan = _mk_plan([_mk_task("T01")])
        result = check_plan(plan, contracts=None)
        # 不应有契约相关检查项
        assert not any("contract" in i.check for i in result.items)

    def test_contracts_have_provider_consumer_pass(self) -> None:
        contracts = ServiceContracts(
            contracts=[
                Contract(
                    id="C-auth",
                    provider="auth",
                    consumers=["gateway"],
                    surface="token",
                    integration_cases=["ic1"],
                )
            ]
        )
        plan = _mk_plan(
            [
                _mk_task("T01", service="auth", provides=["C-auth"]),
                _mk_task("T02", service="gateway", consumes=["C-auth"]),
            ]
        )
        result = check_plan(plan, contracts=contracts)
        items = [i for i in result.items if i.check == "contract_provider_consumer_have_tasks"]
        assert items and all(i.passed for i in items)

    def test_contracts_missing_consumer_task_fails(self) -> None:
        contracts = ServiceContracts(
            contracts=[
                Contract(
                    id="C-auth",
                    provider="auth",
                    consumers=["gateway", "billing"],
                    surface="token",
                    integration_cases=["ic1"],
                )
            ]
        )
        # 只有 auth + gateway 的 task, 缺 billing
        plan = _mk_plan(
            [
                _mk_task("T01", service="auth", provides=["C-auth"]),
                _mk_task("T02", service="gateway", consumes=["C-auth"]),
            ]
        )
        result = check_plan(plan, contracts=contracts)
        items = [i for i in result.items if i.check == "contract_provider_consumer_have_tasks"]
        assert any(not i.passed for i in items)

def test_default_path_overlap_detects_conflict() -> None:
    plan = _mk_plan(
        [
            _mk_task("T01", paths=["src/shared/**"]),
            _mk_task("T02", paths=["src/shared/**"]),
        ]
    )
    result = check_plan(plan)
    items = [i for i in result.items if i.check == "parallel_paths_disjoint"]
    assert any(not i.passed for i in items)


def test_contract_service_task_without_explicit_contract_declaration_fails() -> None:
    contracts = ServiceContracts(
        contracts=[
            Contract(
                id="C-auth",
                provider="auth",
                consumers=["gateway"],
                surface="token",
                integration_cases=["ic1"],
            )
        ]
    )
    plan = _mk_plan(
        [
            _mk_task("T01", service="auth", provides=[]),
            _mk_task("T02", service="gateway", consumes=[]),
        ]
    )
    result = check_plan(plan, contracts=contracts)
    items = [i for i in result.items if i.check == "contract_provider_consumer_have_tasks"]
    assert any(not i.passed for i in items)
    assert "provides_contracts" in items[0].detail
    assert "consumes_contracts" in items[0].detail
