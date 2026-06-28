"""§11.2 contracts_diff 测试."""
from __future__ import annotations

from loop_engineering.multi_service.contracts_diff import (
    ContractChange,
    diff_contracts,
    has_surface_change,
)
from loop_engineering.schema.service_contracts import Contract, ServiceContracts


def _mk_contracts(items: list[Contract]) -> ServiceContracts:
    return ServiceContracts(contracts=items)


def _mk_contract(
    cid: str = "C1",
    provider: str = "auth",
    consumers: list[str] | None = None,
    surface: str = "v1",
    integration_cases: list[str] | None = None,
) -> Contract:
    return Contract(
        id=cid,
        provider=provider,
        consumers=consumers if consumers is not None else ["gateway"],
        surface=surface,
        integration_cases=integration_cases or ["ic1"],
    )


class TestDiffAddedRemoved:
    def test_diff_added(self) -> None:
        before = _mk_contracts([_mk_contract("C1")])
        after = _mk_contracts([_mk_contract("C1"), _mk_contract("C2")])
        diff = diff_contracts(before, after)
        types = [c.change_type for c in diff if c.contract_id == "C2"]
        assert "added" in types

    def test_diff_removed(self) -> None:
        before = _mk_contracts([_mk_contract("C1"), _mk_contract("C2")])
        after = _mk_contracts([_mk_contract("C1")])
        diff = diff_contracts(before, after)
        types = [c.change_type for c in diff if c.contract_id == "C2"]
        assert "removed" in types


class TestSurfaceChange:
    def test_surface_changed(self) -> None:
        before = _mk_contracts([_mk_contract("C1", surface="v1")])
        after = _mk_contracts([_mk_contract("C1", surface="v2")])
        diff = diff_contracts(before, after)
        types = [c.change_type for c in diff if c.contract_id == "C1"]
        assert "surface_changed" in types
        assert has_surface_change(diff) is True

    def test_has_surface_change_false_when_only_consumer_changed(self) -> None:
        before = _mk_contracts([_mk_contract("C1", consumers=["gateway"])])
        after = _mk_contracts([_mk_contract("C1", consumers=["gateway", "billing"])])
        diff = diff_contracts(before, after)
        assert has_surface_change(diff) is False
        types = [c.change_type for c in diff]
        assert "consumer_added" in types


class TestNoChange:
    def test_no_change_returns_empty(self) -> None:
        c = _mk_contract("C1")
        before = _mk_contracts([c])
        after = _mk_contracts([_mk_contract("C1")])
        diff = diff_contracts(before, after)
        assert diff == []


class TestIntegrationCaseChange:
    def test_integration_cases_changed(self) -> None:
        before = _mk_contracts([_mk_contract("C1", integration_cases=["ic1"])])
        after = _mk_contracts([_mk_contract("C1", integration_cases=["ic1", "ic2"])])
        diff = diff_contracts(before, after)
        types = [c.change_type for c in diff]
        assert "integration_case_changed" in types


class TestConsumerChangeOnly:
    def test_consumer_removed(self) -> None:
        before = _mk_contracts([_mk_contract("C1", consumers=["gateway", "billing"])])
        after = _mk_contracts([_mk_contract("C1", consumers=["gateway"])])
        diff = diff_contracts(before, after)
        types = [c.change_type for c in diff]
        assert "consumer_removed" in types
