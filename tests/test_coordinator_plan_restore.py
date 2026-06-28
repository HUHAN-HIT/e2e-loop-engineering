"""回归测试: Coordinator 跨进程恢复 plan (对应端到端断链).

背景: CLI 每个子命令都新建一个 Coordinator, 只 read_run_state 恢复 state.
若不从 planning/task-plan.yaml 恢复 self.plan, 则 `run`/`wrap-up` 命令重建
Coordinator 后 self.plan=None, run_tick 抛 "plan 为空". 本测试固化恢复行为.
"""
from __future__ import annotations

from loop_engineering.dispatch.worker_runner import InlineWorkerRunner, WorkerOutcome
from loop_engineering.runtime.coordinator import Coordinator
from loop_engineering.runtime.directory import init_run_dir, write_run_state
from loop_engineering.schema.run_state import Complexity, Phase, RunState
from loop_engineering.schema.task_plan import Task, TaskPlan


def _noop_worker(packet) -> WorkerOutcome:
    return WorkerOutcome(status="completed")


def test_coordinator_restores_plan_from_disk(tmp_path):
    """已落盘 task-plan.yaml 时, 新建 Coordinator 应恢复 self.plan."""
    runs_root = tmp_path / "runs"
    run_id = "20260627-001"
    run_dir = init_run_dir(runs_root, run_id, "需求: smoke")
    write_run_state(
        run_dir,
        RunState(run_id=run_id, complexity=Complexity.simple, phase=Phase.IMPLEMENTING),
    )
    plan = TaskPlan(
        complexity=Complexity.simple,
        tasks=[
            Task(
                id="T01",
                title="smoke",
                allowed_write_paths=["src/**"],
                acceptance_refs=["AC-001"],
            )
        ],
    )
    plan.to_yaml_file(run_dir / "planning" / "task-plan.yaml")

    coord = Coordinator(run_dir, InlineWorkerRunner(_noop_worker))

    assert coord.plan is not None, "新建 Coordinator 未从磁盘恢复 plan"
    assert [t.id for t in coord.plan.tasks] == ["T01"]


def test_coordinator_plan_none_when_no_plan_file(tmp_path):
    """尚无 task-plan.yaml (如 CREATED 阶段) 时, self.plan 应为 None, 不报错."""
    runs_root = tmp_path / "runs"
    run_id = "20260627-002"
    run_dir = init_run_dir(runs_root, run_id, "需求: smoke")
    write_run_state(
        run_dir,
        RunState(run_id=run_id, complexity=Complexity.simple, phase=Phase.CREATED),
    )

    coord = Coordinator(run_dir, InlineWorkerRunner(_noop_worker))

    assert coord.plan is None
