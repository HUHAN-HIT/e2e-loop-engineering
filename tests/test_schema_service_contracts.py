"""tests for loop_engineering.schema.service_contracts."""
from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from loop_engineering.schema.service_contracts import (
    Contract,
    ServiceContracts,
    ServiceMap,
    ServiceMapEntry,
)


def test_contract_fields() -> None:
    """Contract 必填与可选字段 (design §11.2)."""
    c = Contract(
        id="C-auth-token",
        provider="auth",
        consumers=["gateway", "billing"],
        surface="POST /token → { access_token, scope }",
        acceptance_refs=["AC-007"],
        integration_cases=["IT-001"],
    )
    assert c.id == "C-auth-token"
    assert c.provider == "auth"
    assert c.consumers == ["gateway", "billing"]
    assert "IT-001" in c.integration_cases

    # 可选字段默认
    c2 = Contract(
        id="C-x",
        provider="auth",
        consumers=["gateway"],
        surface="x",
    )
    assert c2.acceptance_refs == []
    assert c2.integration_cases == []


def test_service_contracts_yaml_roundtrip(tmp_path: Path) -> None:
    """service-contracts.yaml 往返一致 (design §11.2)."""
    sc = ServiceContracts(
        contracts=[
            Contract(
                id="C-auth-token",
                provider="auth",
                consumers=["gateway", "billing"],
                surface="POST /token → { access_token, scope }",
                acceptance_refs=["AC-007"],
                integration_cases=["IT-001"],
            ),
        ]
    )
    out = tmp_path / "service-contracts.yaml"
    sc.to_yaml_file(out)
    sc2 = ServiceContracts.from_yaml_file(out)
    assert sc2.schema_ == "loop-engineering.service-contracts.v1"
    assert len(sc2.contracts) == 1
    assert sc2.contracts[0].id == "C-auth-token"
    assert sc2.contracts[0].consumers == ["gateway", "billing"]


def test_contract_id_uniqueness() -> None:
    """重复 contract id → ValidationError."""
    with pytest.raises(ValidationError) as exc_info:
        ServiceContracts(
            contracts=[
                Contract(
                    id="C-dup",
                    provider="auth",
                    consumers=["gw"],
                    surface="x",
                ),
                Contract(
                    id="C-dup",
                    provider="auth",
                    consumers=["gw2"],
                    surface="y",
                ),
            ]
        )
    assert "C-dup" in str(exc_info.value)


def test_contract_id_unique_ok() -> None:
    """id 全不同 → 合法."""
    sc = ServiceContracts(
        contracts=[
            Contract(id="C-a", provider="x", consumers=["y"], surface="a"),
            Contract(id="C-b", provider="x", consumers=["y"], surface="b"),
        ]
    )
    assert len(sc.contracts) == 2


def test_service_map_roundtrip(tmp_path: Path) -> None:
    """service-map.yaml 往返一致 (design §11.4)."""
    sm = ServiceMap(
        services={
            "auth": ServiceMapEntry(worktree="../wt/auth"),
            "gateway": ServiceMapEntry(worktree="../wt/gateway"),
        }
    )
    out = tmp_path / "service-map.yaml"
    sm.to_yaml_file(out)
    sm2 = ServiceMap.from_yaml_file(out)
    assert sm2.schema_ == "loop-engineering.service-map.v1"
    assert sm2.services["auth"].worktree == "../wt/auth"
    assert sm2.services["gateway"].worktree == "../wt/gateway"


def test_service_map_entry_extra_allow() -> None:
    """ServiceMapEntry extra=allow 允许未来加字段."""
    e = ServiceMapEntry.model_validate(
        {"worktree": "../wt/auth", "build_cmd": "make auth"}
    )
    assert e.worktree == "../wt/auth"
    assert getattr(e, "build_cmd") == "make auth"
