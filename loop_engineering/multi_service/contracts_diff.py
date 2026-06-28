"""§11.2 "契约改没改" 的权威判定源 (第 1 层).

规范源: design §11.2 —— service-contracts.yaml 的版本 diff 是契约变更的权威触发源
(worker 在 summary 里声明的 ContractChange 是第 2 层及早信号, 不一致时以权威为准).

变更类型: added / removed / surface_changed / consumer_added / consumer_removed /
integration_case_changed. surface_changed 是触发"契约变更传播" (§11.2) 的唯一信号 ——
consumer 变更只改成员, 不改接口契约本身, 不传播 (但记入 diff).
"""
from __future__ import annotations

from dataclasses import dataclass

from loop_engineering.schema.service_contracts import ServiceContracts


@dataclass(frozen=True)
class ContractChange:
    """单个 contract 在 before/after 之间的变更.

    Attributes:
        contract_id: contract id.
        change_type: added / removed / surface_changed / consumer_added /
            consumer_removed / integration_case_changed.
        before: 旧值 (added 时为 None).
        after: 新值 (removed 时为 None).
    """

    contract_id: str
    change_type: str
    before: str | None
    after: str | None


def diff_contracts(
    before: ServiceContracts, after: ServiceContracts
) -> list[ContractChange]:
    """对比两个版本的 service-contracts.yaml, 返回所有变更.

    按 contract id 配对:
    - 仅在 after: added.
    - 仅在 before: removed.
    - 两边都有: 对比 surface / consumers / integration_cases, 任一变化生成对应 change_type.
      surface 变更优先于 consumer 变更 (它触发传播), 同一 contract 可同时多条 change.
    """
    before_by_id = {c.id: c for c in before.contracts}
    after_by_id = {c.id: c for c in after.contracts}
    changes: list[ContractChange] = []

    for cid in sorted(after_by_id.keys() - before_by_id.keys()):
        c = after_by_id[cid]
        changes.append(
            ContractChange(
                contract_id=cid,
                change_type="added",
                before=None,
                after=c.surface,
            )
        )

    for cid in sorted(before_by_id.keys() - after_by_id.keys()):
        c = before_by_id[cid]
        changes.append(
            ContractChange(
                contract_id=cid,
                change_type="removed",
                before=c.surface,
                after=None,
            )
        )

    for cid in sorted(before_by_id.keys() & after_by_id.keys()):
        b = before_by_id[cid]
        a = after_by_id[cid]
        if b.surface != a.surface:
            changes.append(
                ContractChange(
                    contract_id=cid,
                    change_type="surface_changed",
                    before=b.surface,
                    after=a.surface,
                )
            )
        b_consumers = set(b.consumers)
        a_consumers = set(a.consumers)
        for added in sorted(a_consumers - b_consumers):
            changes.append(
                ContractChange(
                    contract_id=cid,
                    change_type="consumer_added",
                    before=None,
                    after=added,
                )
            )
        for removed in sorted(b_consumers - a_consumers):
            changes.append(
                ContractChange(
                    contract_id=cid,
                    change_type="consumer_removed",
                    before=removed,
                    after=None,
                )
            )
        if list(b.integration_cases) != list(a.integration_cases):
            changes.append(
                ContractChange(
                    contract_id=cid,
                    change_type="integration_case_changed",
                    before=",".join(b.integration_cases),
                    after=",".join(a.integration_cases),
                )
            )

    return changes


def has_surface_change(diff: list[ContractChange]) -> bool:
    """是否存在 surface_changed (§11.2 传播的权威信号)."""
    return any(c.change_type == "surface_changed" for c in diff)
