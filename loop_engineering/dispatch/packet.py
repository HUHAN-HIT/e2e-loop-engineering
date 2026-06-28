"""给 worker 的最小派发 packet (design §0.4 artifact-first, §prompts §D 输入 schema).

规范源: design §0.4 —— coordinator 只把"最小必读切片"作为 context_paths 喂给 worker,
worker 自己定位相关段. 依赖 task 的 summary.md 作为 dependency_artifacts (按需自读),
不让 worker 拿到全局上下文 (隔离的 hallucination 边界).

不依赖 WorkerRunner, 是纯数据. 由 coordinator 用 build_packet 构造, runner.dispatch 消费.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from ..schema.task_plan import Task, TaskPlan

__all__ = ["WorkerPacket", "build_packet"]


@dataclass(frozen=True)
class WorkerPacket:
    """coordinator 派发给 worker 的最小 packet.

    worker 只看这个 + context_paths, 不读全局上下文 (artifact-first, design §0.4).

    Attributes:
        task_id: 当前 task 的 id.
        context_paths: coordinator 切好的最小必读切片 (design.md 全文 + task-plan.yaml 全文,
            worker 自己定位相关段 —— 简化版不做段级切片).
        dependency_artifacts: 依赖 task 的 summary.md 路径列表, 按需自读.
        planned_test_cases: task.tests (list[TestCase]), worker 写测试去满足这些 case.
        allowed_write_paths: task.allowed_write_paths, 越界会被 actual_writes 抓.
        provides_contracts: 多服务: 该 task 提供的契约 id.
        consumes_contracts: 多服务: 该 task 消费的契约 id.
        workdir: 实际工作目录 (用于 actual_writes 采集的 fs snapshot / git diff 基线).
    """

    task_id: str
    context_paths: list[Path]
    dependency_artifacts: list[Path]
    planned_test_cases: list = field(default_factory=list)
    allowed_write_paths: list[str] = field(default_factory=list)
    provides_contracts: list[str] = field(default_factory=list)
    consumes_contracts: list[str] = field(default_factory=list)
    workdir: Path = Path(".")


def build_packet(
    task: Task,
    plan: TaskPlan,
    run_dir: Path,
    *,
    design_md: Path,
    task_plan_yaml: Path,
    workdir: Path | None = None,
) -> WorkerPacket:
    """从 task + plan 构造 packet.

    Args:
        task: 要派发的 task.
        plan: 整个 TaskPlan (用于反查依赖 task, 不直接传 plan 给 worker).
        run_dir: run 根目录 (用于定位 tasks/<dep_id>/summary.md).
        design_md: planning/design.md 路径, 作为 context_paths 之一.
        task_plan_yaml: planning/task-plan.yaml 路径, 作为 context_paths 之一.
        workdir: 实际代码工作目录 (默认 run_dir.parent —— 假设代码在 run_dir 之外).

    Returns:
        WorkerPacket (frozen).

    Notes:
        - context_paths 不做段级切片 (MVP 简化), worker 自行定位相关段.
        - dependency_artifacts 只放已 complete 的依赖 task 的 summary.md; 未 complete
          的依赖不会出现在这里 (因为 ready_frontier 已挡).
        - 缺失的 summary.md 文件不报错 (仍写进列表, worker 读到不存在就跳过 —— 它是软信号).
    """
    run_dir = Path(run_dir)
    design_md = Path(design_md)
    task_plan_yaml = Path(task_plan_yaml)
    if workdir is None:
        workdir = run_dir.parent

    # 只放 complete 的依赖 task 的 summary.md (理论上 ready_frontier 已保证).
    by_id = {t.id: t for t in plan.tasks}
    dep_artifacts: list[Path] = []
    for dep_id in task.depends_on:
        dep_task = by_id.get(dep_id)
        if dep_task is None:
            continue
        dep_artifacts.append(run_dir / "tasks" / dep_id / "summary.md")

    return WorkerPacket(
        task_id=task.id,
        context_paths=[design_md, task_plan_yaml],
        dependency_artifacts=dep_artifacts,
        planned_test_cases=list(task.tests),
        allowed_write_paths=list(task.allowed_write_paths),
        provides_contracts=list(task.provides_contracts),
        consumes_contracts=list(task.consumes_contracts),
        workdir=Path(workdir),
    )
