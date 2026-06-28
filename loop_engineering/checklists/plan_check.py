"""§2.1 计划自检 (全部客观可判定项).

规范源: design §2.1 计划自检 + §11.2 多服务契约自检.
不做语义判断 ("summary 是否充分"), 只做有/无、在/不在、成环/无环.

调用入口 check_plan:
- 单服务 run (contracts=None) 跑前 4 项核心检查.
- 多服务 run 追加 3 项契约检查 (§11.2).
- path_overlap_fn 通过参数注入 (= S3.path_globs_overlap), 解耦避免循环依赖.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from loop_engineering.schema.service_contracts import ServiceContracts
from loop_engineering.schema.task_plan import TaskPlan


@dataclass(frozen=True)
class PlanCheckItem:
    """单条计划自检结果.

    Attributes:
        check: 检查项标识 (见模块 docstring 列表).
        passed: 该项是否通过.
        detail: 失败时的诊断信息 (哪个 AC / 哪个 task 出问题).
    """

    check: str
    passed: bool
    detail: str = ""


@dataclass(frozen=True)
class PlanCheckResult:
    """计划自检汇总."""

    items: list[PlanCheckItem] = field(default_factory=list)

    @property
    def all_pass(self) -> bool:
        """全部通过 = 至少有一项且全 pass."""
        return bool(self.items) and all(i.passed for i in self.items)


def check_plan(
    plan: TaskPlan,
    *,
    contracts: ServiceContracts | None = None,
    path_overlap_fn: Callable[[list[str], list[str]], bool] | None = None,
) -> PlanCheckResult:
    """跑 §2.1 全部检查项.

    单服务 run (contracts=None) 跑前 4 项; 多服务 run 追加后 3 项契约检查.
    path_overlap_fn 缺省时使用真实 S3.path_globs_overlap, 避免公共调用漏传后误放行.
    """
    if path_overlap_fn is None:
        from loop_engineering.scheduling.path_overlap import path_globs_overlap

        path_overlap_fn = path_globs_overlap

    items: list[PlanCheckItem] = []
    items.extend(_check_ac_has_task_and_test(plan))
    items.extend(_check_task_has_required_fields(plan))
    items.extend(_check_parallel_paths_disjoint(plan, path_overlap_fn))
    items.extend(_check_deps_no_cycle(plan))

    if contracts is not None:
        items.extend(_check_contracts_have_provider_consumer_tasks(plan, contracts))
        items.extend(_check_contracts_have_integration_cases(contracts))
        items.extend(_check_provider_updates_contracts_yaml(plan, contracts))

    return PlanCheckResult(items=items)


# ---------------------------------------------------------------------------
# §2.1 前 4 项 (单服务 / 多服务都要跑)
# ---------------------------------------------------------------------------


def _check_ac_has_task_and_test(plan: TaskPlan) -> list[PlanCheckItem]:
    """每个 AC 至少映射一个 task 且该 task 有至少一条 test.

    扫 plan.tasks, 收集所有 acceptance_refs. 对每条 ref:
    - 出现在某 task.acceptance_refs 且该 task.tests 非空 → pass
    - 否则 fail, detail='AC <ref> 缺 task 或缺测试'.
    """
    items: list[PlanCheckItem] = []
    # AC -> 是否至少有一个对应 task 且该 task 有 test.
    ac_has_task_with_test: dict[str, bool] = {}
    for t in plan.tasks:
        for ref in t.acceptance_refs:
            if t.tests:
                ac_has_task_with_test[ref] = True
            else:
                # 没出现 True 就保持 False
                ac_has_task_with_test.setdefault(ref, False)

    for ref in sorted(ac_has_task_with_test):
        ok = ac_has_task_with_test[ref]
        items.append(
            PlanCheckItem(
                check="ac_has_task_and_test",
                passed=ok,
                detail="" if ok else f"AC {ref!r} 缺 task 或缺测试",
            )
        )
    return items


def _check_task_has_required_fields(plan: TaskPlan) -> list[PlanCheckItem]:
    """每个 task 有 allowed_write_paths / depends_on / acceptance_refs.

    depends_on 允许空 (叶子 task). allowed_write_paths 与 acceptance_refs 空则 fail.
    """
    items: list[PlanCheckItem] = []
    for t in plan.tasks:
        missing: list[str] = []
        if not t.allowed_write_paths:
            missing.append("allowed_write_paths")
        if not t.acceptance_refs:
            missing.append("acceptance_refs")
        # depends_on 可空, 不查.
        if missing:
            items.append(
                PlanCheckItem(
                    check="task_has_fields",
                    passed=False,
                    detail=f"task {t.id} 缺必填字段: {missing}",
                )
            )
        else:
            items.append(
                PlanCheckItem(check="task_has_fields", passed=True, detail=f"task {t.id}")
            )
    return items


def _check_parallel_paths_disjoint(
    plan: TaskPlan, path_overlap_fn: Callable[[list[str], list[str]], bool]
) -> list[PlanCheckItem]:
    """可并行 task (depends_on 闭包内无相互依赖) 的写路径不重叠.

    实现简化: 对每对 (a, b), 若 a 不依赖 b 且 b 不依赖 a (含传递闭包, 但本简化用直接依赖
    足够覆盖典型场景), 视为可并行; exclusive 不算违规 (它本就独占).
    路径重叠用注入的 path_overlap_fn.
    """
    items: list[PlanCheckItem] = []
    tasks = list(plan.tasks)
    # 直接依赖集合
    deps: dict[str, set[str]] = {t.id: set(t.depends_on) for t in tasks}

    def reachable(start: str) -> set[str]:
        seen: set[str] = set()
        stack: list[str] = list(deps.get(start, ()))
        while stack:
            cur = stack.pop()
            if cur in seen:
                continue
            seen.add(cur)
            stack.extend(deps.get(cur, ()))
        return seen

    closure = {tid: reachable(tid) for tid in deps}

    for i, a in enumerate(tasks):
        for b in tasks[i + 1 :]:
            # 互相在闭包内即有依赖, 不算可并行
            if b.id in closure[a.id] or a.id in closure[b.id]:
                continue
            # exclusive task 独占, 不算路径冲突 (本就是串行排他的)
            if a.exclusive or b.exclusive:
                continue
            if path_overlap_fn(a.allowed_write_paths, b.allowed_write_paths):
                items.append(
                    PlanCheckItem(
                        check="parallel_paths_disjoint",
                        passed=False,
                        detail=f"可并行 task {a.id} 与 {b.id} 的 allowed_write_paths 重叠",
                    )
                )
    if not any(it.check == "parallel_paths_disjoint" and not it.passed for it in items):
        items.append(PlanCheckItem(check="parallel_paths_disjoint", passed=True, detail="无重叠"))
    return items


def _check_deps_no_cycle(plan: TaskPlan) -> list[PlanCheckItem]:
    """depends_on 不成环 (DFS 三色标记)."""
    tasks = {t.id: set(t.depends_on) for t in plan.tasks}

    WHITE, GRAY, BLACK = 0, 1, 2
    color: dict[str, int] = {tid: WHITE for tid in tasks}
    has_cycle = False

    def dfs(node: str) -> None:
        nonlocal has_cycle
        color[node] = GRAY
        for nxt in tasks.get(node, ()):
            if nxt not in color:
                # 依赖不存在的 task, 视为有效但孤立的标识, 不计环
                continue
            if color[nxt] == GRAY:
                has_cycle = True
                return
            if color[nxt] == WHITE:
                dfs(nxt)
                if has_cycle:
                    return
        color[node] = BLACK

    for tid in list(tasks):
        if color[tid] == WHITE:
            dfs(tid)
            if has_cycle:
                break

    return [
        PlanCheckItem(
            check="deps_no_cycle",
            passed=not has_cycle,
            detail="" if not has_cycle else "depends_on 存在环",
        )
    ]


# ---------------------------------------------------------------------------
# §11.2 多服务契约自检 (仅在 contracts 提供时跑)
# ---------------------------------------------------------------------------


def _check_contracts_have_provider_consumer_tasks(
    plan: TaskPlan, contracts: ServiceContracts
) -> list[PlanCheckItem]:
    """每 contract 的 provider/consumers 都必须有显式 contract task.

    只存在同 service 的 task 不够; provider task 必须声明 provides_contracts,
    consumer task 必须声明 consumes_contracts. 否则多服务契约会被普通服务任务伪装通过.
    """
    items: list[PlanCheckItem] = []

    for c in contracts.contracts:
        provider_tasks = [
            t.id for t in plan.tasks if t.service == c.provider and c.id in t.provides_contracts
        ]
        missing: list[str] = []
        if not provider_tasks:
            missing.append(
                f"provider {c.provider!r} 缺声明 provides_contracts={c.id!r} 的 task"
            )

        for consumer in c.consumers:
            consumer_tasks = [
                t.id for t in plan.tasks if t.service == consumer and c.id in t.consumes_contracts
            ]
            if not consumer_tasks:
                missing.append(
                    f"consumer {consumer!r} 缺声明 consumes_contracts={c.id!r} 的 task"
                )

        if missing:
            items.append(
                PlanCheckItem(
                    check="contract_provider_consumer_have_tasks",
                    passed=False,
                    detail=f"contract {c.id}: " + "; ".join(missing),
                )
            )
        else:
            items.append(
                PlanCheckItem(
                    check="contract_provider_consumer_have_tasks",
                    passed=True,
                    detail=f"contract {c.id}",
                )
            )
    return items


def _check_contracts_have_integration_cases(
    contracts: ServiceContracts,
) -> list[PlanCheckItem]:
    """每 contract 至少一个 integration_cases."""
    items: list[PlanCheckItem] = []
    for c in contracts.contracts:
        ok = bool(c.integration_cases)
        items.append(
            PlanCheckItem(
                check="contract_has_integration_case",
                passed=ok,
                detail="" if ok else f"contract {c.id} 无 integration_cases",
            )
        )
    return items


def _check_provider_updates_contracts_yaml(
    plan: TaskPlan, contracts: ServiceContracts
) -> list[PlanCheckItem]:
    """provider task 若触及契约 surface, contracts 里需有该 contract.

    静态可判的部分: task.provides_contracts 中每个 id 都能在 contracts 找到对应记录.
    (真实 surface diff 由 contracts_diff.py 做, 这里只查静态登记的对应性.)
    """
    items: list[PlanCheckItem] = []
    contract_ids = {c.id for c in contracts.contracts}
    for t in plan.tasks:
        if not t.provides_contracts:
            continue
        for cid in t.provides_contracts:
            if cid not in contract_ids:
                items.append(
                    PlanCheckItem(
                        check="provider_updates_contracts_yaml",
                        passed=False,
                        detail=f"task {t.id} 声明 provides_contracts 含 {cid!r}, 但 service-contracts.yaml 未登记",
                    )
                )
    if not any(it.check == "provider_updates_contracts_yaml" and not it.passed for it in items):
        items.append(
            PlanCheckItem(
                check="provider_updates_contracts_yaml",
                passed=True,
                detail="所有 provider task 声明的 contract 均已登记",
            )
        )
    return items
