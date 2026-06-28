"""多服务契约模型 (design §11.2 / §11.4, 单服务 run 不涉及).

规范源: design §11.2 (service-contracts.yaml 契约一等建模)、§11.4 (service-map.yaml 多 repo 映射).
"""
from __future__ import annotations

from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict, Field, model_validator


class Contract(BaseModel):
    """单个跨服务契约 (design §11.2).

    id 如 C-auth-token; provider/consumers 是 service name;
    surface 描述 API / 消息 / 共享类型.
    """

    id: str
    provider: str
    consumers: list[str]
    surface: str
    acceptance_refs: list[str] = []
    integration_cases: list[str] = []


class ServiceContracts(BaseModel):
    """planning/service-contracts.yaml 模型 (design §11.2).

    把跨服务接口显式登记, 防契约漂移. contract id 唯一.
    """

    model_config = ConfigDict(populate_by_name=True)

    schema_: str = Field(
        default="loop-engineering.service-contracts.v1", alias="schema"
    )
    contracts: list[Contract]

    @model_validator(mode="after")
    def _check_id_uniqueness(self) -> "ServiceContracts":
        """contract id 必须唯一."""
        seen: set[str] = set()
        dup: list[str] = []
        for c in self.contracts:
            if c.id in seen:
                dup.append(c.id)
            seen.add(c.id)
        if dup:
            raise ValueError(
                f"contract id 重复 (design §11.2): {sorted(set(dup))}"
            )
        return self

    def to_yaml_file(self, path: Path) -> None:
        """序列化到 service-contracts.yaml. 用 mode="json" 退枚举."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        data = self.model_dump(by_alias=True, exclude_none=False, mode="json")
        path.write_text(
            yaml.safe_dump(data, sort_keys=False, allow_unicode=True),
            encoding="utf-8",
        )

    @classmethod
    def from_yaml_file(cls, path: Path) -> "ServiceContracts":
        """从 service-contracts.yaml 反序列化."""
        data = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
        return cls.model_validate(data)


class ServiceMapEntry(BaseModel):
    """service → worktree 物理路径映射 (design §11.4).

    extra="allow": 允许未来加字段 (例如 lockfile 路径、构建命令).
    """

    model_config = ConfigDict(extra="allow")

    worktree: str


class ServiceMap(BaseModel):
    """planning/service-map.yaml 模型 (design §11.4).

    多 repo 时把 service 落到物理树; monorepo 下 §11.1 的 service:path 已足够, 不用此文件.
    去掉了旧版 worktree-binding 的防伪 attestation.
    """

    model_config = ConfigDict(populate_by_name=True)

    schema_: str = Field(default="loop-engineering.service-map.v1", alias="schema")
    services: dict[str, ServiceMapEntry] = {}

    def to_yaml_file(self, path: Path) -> None:
        """序列化到 service-map.yaml. 用 mode="json" 退枚举."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        data = self.model_dump(by_alias=True, exclude_none=False, mode="json")
        path.write_text(
            yaml.safe_dump(data, sort_keys=False, allow_unicode=True),
            encoding="utf-8",
        )

    @classmethod
    def from_yaml_file(cls, path: Path) -> "ServiceMap":
        """从 service-map.yaml 反序列化."""
        data = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
        return cls.model_validate(data)
