"""§11.2 "契约变更传播 (核心机制, 是依赖边不是裁判)".

规范源: design §11.2 —— provider 改了 contract 的 surface, 所有 consumer task 必须
"重新验证对应契约", 表现为依赖图上加一条隐式边 consumer_task → provider_task.

关键设计点:
- 只有 surface_changed 触发传播 (consumer_added/removed 只改成员, 不改契约本身).
- 隐式依赖只描述, apply 由调用方 (S8 coordinator) 决定何时落到 plan.tasks.
- 不实际跑集成测试, 那是收口阶段 worker 的事 (§11.3).
"""
from __future__ import annotations

from dataclasses import dataclass, field

from loop_engineering.multi_service.contracts_diff import ContractChange, has_surface_change
from loop_engineering.schema.service_contracts import ServiceContracts
from loop_engineering.schema.task_plan import Task, TaskPlan


@dataclass(frozen=True)
class PropagationResult:
    """provider 改契约后, 需重新验证的 consumer task 集合."""

    changed_contracts: list[str] = field(default_factory=list)
    affected_consumer_tasks: list[str] = field(default_factory=list)
    implicit_dependencies_added: list[tuple[str, str]] = field(default_factory=list)


def propagate_contract_changes(
    plan: TaskPlan,
    contracts: ServiceContracts,
    contract_diff: list[ContractChange],
) -> PropagationResult:
    """对每个 surface_changed 的 contract 计算需新增的隐式依赖.

    步骤 (§11.2):
    1. 从 contract_diff 取 surface_changed 的 contract id.
    2. 对每个: 找 provider task (task.service == contract.provider 且 provides_contracts 含 id)
       与所有 consumer task (task.service ∈ contract.consumers 且 consumes_contracts 含 id).
    3. 给每对 (consumer_task, provider_task) 加隐式依赖边.

    Returns:
        PropagationResult. changed_contracts 已去重; affected_consumer_tasks 与
        implicit_dependencies_added 已按 (consumer, provider) 去重.
    """
    if not has_surface_change(contract_diff):
        return PropagationResult()

    # 改了 surface 的 contract id -> 对应的 contract (从 contracts 取 provider/consumers)
    changed_ids = {c.contract_id for c in contract_diff if c.change_type == "surface_changed"}
    contracts_by_id = {c.id: c for c in contracts.contracts}

    tasks_by_id: dict[str, Task] = {t.id: t for t in plan.tasks}

    # 索引: provider/consumer service -> tasks (匹配 provides/consumes_contracts)
    def find_provider_task(contract_id: str, provider_service: str) -> Task | None:
        for t in plan.tasks:
            if t.service == provider_service and contract_id in t.provides_contracts:
                return t
        return None

    def find_consumer_tasks(contract_id: str, consumer_services: list[str]) -> list[Task]:
        out: list[Task] = []
        consumer_set = set(consumer_services)
        for t in plan.tasks:
            if t.service in consumer_set and contract_id in t.consumes_contracts:
                out.append(t)
        return out

    changed_contracts: list[str] = []
    affected: set[str] = set()
    new_edges: set[tuple[str, str]] = set()

    for cid in sorted(changed_ids):
        contract = contracts_by_id.get(cid)
        if contract is None:
            # diff 中提到的 contract 在 contracts 中找不到 —— 异常, 跳过 (保守)
            continue
        provider_task = find_provider_task(cid, contract.provider)
        if provider_task is None:
            continue
        consumer_tasks = find_consumer_tasks(cid, list(contract.consumers))
        if not consumer_tasks:
            continue
        changed_contracts.append(cid)
        for ct in consumer_tasks:
            affected.add(ct.id)
            # 边: consumer_task 依赖 provider_task
            if ct.id == provider_task.id:
                continue  # 自环跳过
            new_edges.add((ct.id, provider_task.id))

    return PropagationResult(
        changed_contracts=changed_contracts,
        affected_consumer_tasks=sorted(affected),
        implicit_dependencies_added=sorted(new_edges),
    )


def apply_implicit_dependencies(
    plan: TaskPlan, propagation: PropagationResult
) -> TaskPlan:
    """把 propagation 的隐式依赖加到 plan.tasks 的 depends_on (去重).

    返回新 TaskPlan (model_copy + 深拷 tasks 的 depends_on), 不改原 plan.
    """
    edges = propagation.implicit_dependencies_added
    if not edges:
        return plan.model_copy(deep=True)

    # consumer_task -> 追加的依赖集合
    additions: dict[str, set[str]] = {}
    for consumer_id, provider_id in edges:
        additions.setdefault(consumer_id, set()).add(provider_id)

    new_tasks: list[Task] = []
    for t in plan.tasks:
        extra = additions.get(t.id)
        if not extra:
            new_tasks.append(t.model_copy(deep=True))
            continue
        merged = list(dict.fromkeys([*t.depends_on, *sorted(extra)]))
        new_tasks.append(t.model_copy(update={"depends_on": merged}))

    return plan.model_copy(update={"tasks": new_tasks})
