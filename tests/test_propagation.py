"""§11.2 契约变更传播测试."""
from __future__ import annotations

from loop_engineering.multi_service.contracts_diff import ContractChange
from loop_engineering.multi_service.propagation import (
    apply_implicit_dependencies,
    propagate_contract_changes,
)
from loop_engineering.schema.run_state import Complexity
from loop_engineering.schema.service_contracts import Contract, ServiceContracts
from loop_engineering.schema.task_plan import Task, TaskPlan


def _mk_task(
    tid: str,
    service: str,
    *,
    provides: list[str] | None = None,
    consumes: list[str] | None = None,
    depends_on: list[str] | None = None,
) -> Task:
    return Task(
        id=tid,
        title=tid,
        allowed_write_paths=[f"src/{service}/**"],
        acceptance_refs=[f"AC-{tid}"],
        service=service,
        provides_contracts=provides or [],
        consumes_contracts=consumes or [],
        depends_on=depends_on or [],
    )


def _mk_plan(tasks: list[Task]) -> TaskPlan:
    return TaskPlan(complexity=Complexity.complex, tasks=tasks)


class TestPropagate:
    def test_propagate_finds_consumer_tasks(self) -> None:
        contracts = ServiceContracts(
            contracts=[
                Contract(
                    id="C-auth-token",
                    provider="auth",
                    consumers=["gateway", "billing"],
                    surface="token",
                )
            ]
        )
        plan = _mk_plan(
            [
                _mk_task("T-auth", "auth", provides=["C-auth-token"]),
                _mk_task("T-gw", "gateway", consumes=["C-auth-token"]),
                _mk_task("T-bill", "billing", consumes=["C-auth-token"]),
            ]
        )
        diff = [
            ContractChange(
                contract_id="C-auth-token",
                change_type="surface_changed",
                before="token",
                after="token-v2",
            )
        ]
        result = propagate_contract_changes(plan, contracts, diff)
        assert result.changed_contracts == ["C-auth-token"]
        assert set(result.affected_consumer_tasks) == {"T-gw", "T-bill"}
        assert ("T-gw", "T-auth") in result.implicit_dependencies_added
        assert ("T-bill", "T-auth") in result.implicit_dependencies_added

    def test_only_surface_changes_propagate(self) -> None:
        # consumer_added 不应触发传播
        contracts = ServiceContracts(
            contracts=[
                Contract(
                    id="C1", provider="auth", consumers=["gateway"], surface="v1"
                )
            ]
        )
        plan = _mk_plan(
            [
                _mk_task("T-auth", "auth", provides=["C1"]),
                _mk_task("T-gw", "gateway", consumes=["C1"]),
            ]
        )
        diff = [
            ContractChange(contract_id="C1", change_type="consumer_added", before=None, after="x")
        ]
        result = propagate_contract_changes(plan, contracts, diff)
        assert result.changed_contracts == []
        assert result.implicit_dependencies_added == []

    def test_no_consumers_no_affected(self) -> None:
        contracts = ServiceContracts(
            contracts=[
                Contract(id="C1", provider="auth", consumers=[], surface="v1")
            ]
        )
        plan = _mk_plan([_mk_task("T-auth", "auth", provides=["C1"])])
        diff = [
            ContractChange(
                contract_id="C1", change_type="surface_changed", before="v1", after="v2"
            )
        ]
        result = propagate_contract_changes(plan, contracts, diff)
        assert result.affected_consumer_tasks == []
        assert result.implicit_dependencies_added == []


class TestApplyImplicitDependencies:
    def test_dedup_existing(self) -> None:
        # T-gw 已依赖 T-auth, 传播又给同一边, 应去重
        contracts = ServiceContracts(
            contracts=[
                Contract(id="C1", provider="auth", consumers=["gateway"], surface="v1")
            ]
        )
        plan = _mk_plan(
            [
                _mk_task("T-auth", "auth", provides=["C1"]),
                _mk_task("T-gw", "gateway", consumes=["C1"], depends_on=["T-auth"]),
            ]
        )
        diff = [
            ContractChange(
                contract_id="C1", change_type="surface_changed", before="v1", after="v2"
            )
        ]
        prop = propagate_contract_changes(plan, contracts, diff)
        new_plan = apply_implicit_dependencies(plan, prop)
        gw = next(t for t in new_plan.tasks if t.id == "T-gw")
        assert gw.depends_on.count("T-auth") == 1

    def test_new_instance_does_not_mutate_original(self) -> None:
        contracts = ServiceContracts(
            contracts=[
                Contract(id="C1", provider="auth", consumers=["gateway"], surface="v1")
            ]
        )
        plan = _mk_plan(
            [
                _mk_task("T-auth", "auth", provides=["C1"]),
                _mk_task("T-gw", "gateway", consumes=["C1"]),
            ]
        )
        diff = [
            ContractChange(
                contract_id="C1", change_type="surface_changed", before="v1", after="v2"
            )
        ]
        prop = propagate_contract_changes(plan, contracts, diff)
        new_plan = apply_implicit_dependencies(plan, prop)
        # 原 plan 的 T-gw.depends_on 仍为空
        orig_gw = next(t for t in plan.tasks if t.id == "T-gw")
        assert orig_gw.depends_on == []
        # 新 plan 的 T-gw 加了依赖
        new_gw = next(t for t in new_plan.tasks if t.id == "T-gw")
        assert "T-auth" in new_gw.depends_on
