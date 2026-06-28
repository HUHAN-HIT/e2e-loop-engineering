"""§11.4 service → worktree 映射 (轻量, 无防伪).

规范源: design §11.4 —— 多 repo 时 service name 落到物理 worktree 路径.
§11.5 明说多 repo 真实实现暂缓, 此处只做路径解析与校验 (不读写真实 git worktree).
"""
from __future__ import annotations

from pathlib import Path

from loop_engineering.schema.service_contracts import ServiceMap
from loop_engineering.schema.task_plan import Task


def resolve_worktree(service_map: ServiceMap, service: str) -> Path:
    """service → worktree 路径.

    Args:
        service_map: planning/service-map.yaml 模型.
        service: service name.

    Returns:
        Path 对象 (不校验存在性, 存在性由 validate_service_map 检).

    Raises:
        KeyError: service 不在 map.
    """
    entry = service_map.services.get(service)
    if entry is None:
        raise KeyError(f"service {service!r} 不在 service-map.yaml")
    return Path(entry.worktree)


def resolve_worktree_for_task(service_map: ServiceMap, task: Task) -> Path:
    """task.service → worktree. task.service=None → 返回当前目录 '.' (单服务场景)."""
    if task.service is None:
        return Path(".")
    return resolve_worktree(service_map, task.service)


def validate_service_map(service_map: ServiceMap, base_dir: Path) -> list[str]:
    """校验每个 worktree 路径存在. 返回问题列表 (空列表 = 全部 OK). 不 raise.

    相对路径以 base_dir 解析; 绝对路径原样使用.
    """
    problems: list[str] = []
    base = Path(base_dir)
    for name, entry in service_map.services.items():
        wt = Path(entry.worktree)
        if not wt.is_absolute():
            wt = base / wt
        if not wt.exists():
            problems.append(f"service {name!r} 的 worktree {entry.worktree!r} 不存在 (解析为 {wt})")
    return problems


def collect_actual_writes_multi_repo(
    service_map: ServiceMap,
    task: Task,
    collections_by_service: dict[str, list[str]],
) -> list[str]:
    """多 repo 下收集 actual_writes.

    按 task.service 查 worktree, 从 collections_by_service[service] 取该 service 的写入清单,
    把每条相对路径前缀化为 "<worktree>/<path>" 以便上层跨 repo 统一比较.

    task.service=None 时退化为返回 collections_by_service.get('', []) 原样 (单服务兜底).
    """
    if task.service is None:
        return list(collections_by_service.get("", collections_by_service.get(task.id, [])))

    worktree = resolve_worktree(service_map, task.service)
    prefix = worktree.as_posix()
    raw_writes = collections_by_service.get(task.service, [])
    out: list[str] = []
    for w in raw_writes:
        if not w:
            continue
        if prefix == "." or prefix == "":
            out.append(w)
        else:
            out.append(f"{prefix}/{w}")
    return out
