"""Loop Engineering 编排器 (design §1 主流程 + §6 单写者 + §3.7 tick 顺序).

Coordinator 是唯一写 run-state.json / task-plan.yaml 的角色 (§prompts §A).
持有 state + plan + 外部 map (started_at / stale_count / capabilities / snapshots),
推进状态机, 与人沟通.

诚实声明: tick 内的"立即翻 running + 同步 dispatch" 是 MVP 简化 (真实场景 runner.dispatch
应是非阻塞异步, 这里用阻塞调用, 测试用 RecordingWorkerRunner 驱动).
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from ..amendment.rollback import apply_rollback, compute_rollback
from ..checklists.plan_check import check_plan
from ..checklists.wrap_up_check import check_wrap_up
from ..dispatch.worker_runner import WorkerOutcome, WorkerRunner
from ..scheduling.capabilities import probe_capabilities
from ..scheduling.path_overlap import path_globs_overlap
from ..schema.artifacts import (
    KeyDiffsFile,
    PlanAmendmentNeeded,
)
from ..schema.clarification import ClarificationAnswers, ClarificationQuestions
from ..schema.run_state import (
    Complexity,
    HumanPending,
    Phase,
    RunCapabilities,
    RunState,
)
from ..schema.service_contracts import ServiceContracts
from ..schema.task_plan import TaskPlan
from ..state_machine.human_anchors import (
    clear_human_pending,
    is_awaiting_human,
    set_human_pending,
)
from ..state_machine.transitions import (
    advance_phase,
    is_terminal,
)
from .directory import (
    init_task_dir,
    read_run_state,
    write_run_state,
)
from .tick import TickResult, tick

__all__ = ["Coordinator"]


def _now_utc() -> datetime:
    """UTC 当前时间."""
    return datetime.now(timezone.utc)


class Coordinator:
    """Loop Engineering 编排器. 持有 run-state + plan, 推进状态机, 与人沟通. 单写者.

    有状态类 (与前面模块的纯函数风格不同): 持有 state + plan + 外部 map.
    每次 submit_* 方法跑对应 checklist, 不通过 → 同一 phase 内修一次, 失败升级给人.
    signoff_* 方法 clear human_pending + advance_phase.
    """

    def __init__(self, run_dir: Path, runner: WorkerRunner):
        self.run_dir = Path(run_dir)
        self.runner = runner
        self.state: RunState = read_run_state(self.run_dir)
        self.plan: TaskPlan | None = None
        self.started_at_by_task: dict[str, datetime] = {}
        self.stale_count_by_task: dict[str, int] = {}
        # capabilities 探测 (§3.4 CREATED 时一次性写入 run-state, 此后固定):
        # 反序列化已有 → 沿用; 缺失 → probe 后挂到 self.state, 由下一次 _refresh_state_file
        # 顺带写回 (不在 __init__ 立即写, 避免 Windows 文件锁 race + 减少 IO).
        if self.state.capabilities is None:
            self.capabilities = probe_capabilities(self.run_dir.parent)
            self.state.capabilities = self.capabilities
        else:
            self.capabilities = self.state.capabilities
        self.before_snapshots: dict[str, dict[str, float]] = {}
        self.earlier_task_writes: dict[str, list[str]] = {}
        # §3.4 base_ref 采集: task_id → 派出前的 git base ref (capabilities.git_diff=True 时填)
        self.base_refs: dict[str, str] = {}
        # 收口阶段缓存的每 task 任务自检结果 + key-diffs
        self._task_check_results: dict = {}
        self._key_diffs_by_task: dict[str, KeyDiffsFile | None] = {}
        # 跨进程恢复: CLI 每个子命令都重建 Coordinator, 仅 read_run_state 恢复 state.
        # plan 必须从 planning/task-plan.yaml 一并恢复, 否则 run/wrap-up 等后续命令
        # 拿到 self.plan=None → run_tick 报 "plan 为空" (端到端断链).
        plan_path = self.run_dir / "planning" / "task-plan.yaml"
        if plan_path.exists():
            self.plan = TaskPlan.from_yaml_file(plan_path)

    # ------------------------------------------------------------------
    # 持久化 helpers
    # ------------------------------------------------------------------
    def _refresh_state_file(self) -> None:
        """把 self.state 写回 run-state.json (单写者, 原子写)."""
        write_run_state(self.run_dir, self.state)

    def _refresh_plan_file(self) -> None:
        """把 self.plan 写回 planning/task-plan.yaml (若 plan 已就绪)."""
        if self.plan is None:
            return
        plan_path = self.run_dir / "planning" / "task-plan.yaml"
        self.plan.to_yaml_file(plan_path)

    # ------------------------------------------------------------------
    # phase 推进
    # ------------------------------------------------------------------
    def start_clarifying(self) -> None:
        """CREATED → CLARIFYING (or skip to PLANNING if 无阻塞性歧义)."""
        if self.state.phase == Phase.CREATED:
            # 简化: 直接跳到 PLANNING (CLARIFYING 可选, design §1).
            self.state = advance_phase(self.state, Phase.PLANNING)
            self._refresh_state_file()

    def submit_clarification(self, q: ClarificationQuestions) -> None:
        """存 questions.json, 等人答 (set human_pending=clarification 若有阻塞性问题)."""
        q.to_json_file(self.run_dir / "clarification" / "questions.json")
        if q.questions and not q.can_proceed_with_defaults:
            self.state = set_human_pending(self.state, HumanPending.clarification)
            self._refresh_state_file()

    def answer_clarification(self, answers: ClarificationAnswers) -> None:
        """存 answers.json, clear clarification anchor → 进 PLANNING."""
        answers_path = self.run_dir / "clarification" / "answers.json"
        answers_path.write_text(
            answers.model_dump_json(by_alias=True, exclude_none=True, indent=2),
            encoding="utf-8",
        )
        if self.state.human_pending == HumanPending.clarification:
            self.state = clear_human_pending(self.state)
        if self.state.phase == Phase.CLARIFYING:
            self.state = advance_phase(self.state, Phase.PLANNING)
        self._refresh_state_file()

    def start_planning(self) -> None:
        """→ PLANNING (从 CREATED 或 CLARIFYING 进)."""
        if self.state.phase in (Phase.CREATED, Phase.CLARIFYING):
            if self.state.phase == Phase.CREATED:
                self.state = advance_phase(self.state, Phase.PLANNING)
            else:
                self.state = advance_phase(self.state, Phase.PLANNING)
            self._refresh_state_file()

    def submit_plan(self, plan: TaskPlan) -> None:
        """plan agent 提交: 跑 plan_check, 通过则 set human_pending=plan_signoff.

        不通过 → 同一 phase 内修一次 (本 MVP 简化: 直接 raise / 给人诊断,
        不自动重试 —— 真实场景由 plan agent 再交一次).
        """
        if self.state.phase != Phase.PLANNING:
            raise RuntimeError(f"submit_plan 必须在 PLANNING phase (当前 {self.state.phase})")
        self.plan = plan
        # 跑计划自检. 多服务契约文件存在时纳入 gate, 避免 service task 伪装契约覆盖.
        contracts = self._read_service_contracts()
        result = check_plan(plan, contracts=contracts, path_overlap_fn=path_globs_overlap)
        if not result.all_pass:
            # 写 plan 但保留 PLANNING, 等人/agent 修. 失败诊断写到 planning/plan-check-failures.json
            self._refresh_plan_file()
            fail_path = self.run_dir / "planning" / "plan-check-failures.json"
            import json
            fail_path.write_text(
                json.dumps(
                    [
                        {"check": i.check, "passed": i.passed, "detail": i.detail}
                        for i in result.items
                        if not i.passed
                    ],
                    indent=2,
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            # 不 set human_pending (让 agent 重交); 不 advance.
            return
        # 通过 → 写 plan + set human_pending=plan_signoff
        self._refresh_plan_file()
        self.state = set_human_pending(self.state, HumanPending.plan_signoff)
        self._refresh_state_file()

    def _read_service_contracts(self) -> ServiceContracts | None:
        """读取 planning/service-contracts.yaml; 不存在表示单服务 run."""
        path = self.run_dir / "planning" / "service-contracts.yaml"
        if not path.exists():
            return None
        return ServiceContracts.from_yaml_file(path)

    def _requires_integration_results(self) -> bool:
        """多服务或契约 run 收口必须提供集成结果."""
        if self.plan is None:
            return False
        if (self.run_dir / "planning" / "service-contracts.yaml").exists():
            return True
        return any(t.service or t.provides_contracts or t.consumes_contracts for t in self.plan.tasks)

    def signoff_plan(self, accepted: bool, *, feedback: str = "") -> None:
        """人盯点 1. accepted=True → clear anchor + → IMPLEMENTING; False → 留 PLANNING."""
        if self.state.phase != Phase.PLANNING:
            raise RuntimeError(f"signoff_plan 必须在 PLANNING phase (当前 {self.state.phase})")
        if accepted:
            self.state = clear_human_pending(self.state)
            self.state = advance_phase(self.state, Phase.IMPLEMENTING)
            self._refresh_state_file()
        else:
            # 拒绝: 留 PLANNING, 把 feedback 写到 planning/signoff-feedback.md.
            (self.run_dir / "planning" / "signoff-feedback.md").write_text(
                feedback, encoding="utf-8"
            )
            # human_pending 保留 plan_signoff (等人重审)
            self._refresh_state_file()

    def start_implementing(self) -> None:
        """→ IMPLEMENTING, 进入 tick 循环 (调用方应改用 run_until_human_or_terminal)."""
        if self.state.phase == Phase.PLANNING and self.plan is not None:
            self.state = advance_phase(self.state, Phase.IMPLEMENTING)
            self._refresh_state_file()

    def submit_wrap_up(self) -> None:
        """→ WRAPPING_UP, 跑收口自检, set human_pending=wrap_up_signoff."""
        if self.state.phase != Phase.IMPLEMENTING:
            raise RuntimeError(
                f"submit_wrap_up 必须在 IMPLEMENTING phase (当前 {self.state.phase})"
            )
        if self.plan is None:
            raise RuntimeError("submit_wrap_up 时 plan 为空")
        self.state = advance_phase(self.state, Phase.WRAPPING_UP)
        # 跑收口自检
        result = check_wrap_up(
            self.plan,
            self._task_check_results,
            self._key_diffs_by_task,
            requires_integration=self._requires_integration_results(),
        )
        # 写结果到 wrap-up/check-result.json
        import json
        (self.run_dir / "wrap-up" / "check-result.json").write_text(
            json.dumps(
                [
                    {"check": i.check, "passed": i.passed, "detail": i.detail}
                    for i in result.items
                ],
                indent=2,
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        if result.all_pass:
            self.state = set_human_pending(self.state, HumanPending.wrap_up_signoff)
        else:
            # 不通过: 不进 signoff, 留 WRAPPING_UP 等人/agent 修.
            # human_pending 保持 None, 让 caller 决定下一步 (回 PLANNING 或修代码).
            pass
        self._refresh_state_file()

    def signoff_wrap_up(self, accepted: bool) -> None:
        """人盯点 2. accepted=True → → COMPLETE; False → 回 PLANNING/IMPLEMENTING."""
        if self.state.phase != Phase.WRAPPING_UP:
            raise RuntimeError(
                f"signoff_wrap_up 必须在 WRAPPING_UP phase (当前 {self.state.phase})"
            )
        if accepted:
            self.state = clear_human_pending(self.state)
            self.state = advance_phase(self.state, Phase.COMPLETE)
            self._refresh_state_file()
        else:
            # 拒绝: 回 IMPLEMENTING 就近返工 (design §1).
            self.state = clear_human_pending(self.state)
            self.state = advance_phase(self.state, Phase.IMPLEMENTING)
            self._refresh_state_file()

    def abort(self, reason: str) -> None:
        """任意 phase → ABORTED. 必须给 reason."""
        self.state = advance_phase(self.state, Phase.ABORTED, aborted_reason=reason)
        self._refresh_state_file()

    # ------------------------------------------------------------------
    # tick 循环
    # ------------------------------------------------------------------
    def run_tick(self) -> TickResult:
        """跑一次 tick (用 self 持有的 state / plan / runner)."""
        if self.plan is None:
            raise RuntimeError("run_tick 时 plan 为空 (先 submit_plan)")
        design_md = self.run_dir / "planning" / "design.md"
        task_plan_yaml = self.run_dir / "planning" / "task-plan.yaml"
        # 设计文档不存在时建一个占位 (MVP), 避免阻塞测试.
        if not design_md.exists():
            design_md.parent.mkdir(parents=True, exist_ok=True)
            design_md.write_text("# Design (placeholder)\n", encoding="utf-8")

        self.state, self.plan, result = tick(
            self.state,
            self.plan,
            self.runner,
            started_at_by_task=self.started_at_by_task,
            stale_count_by_task=self.stale_count_by_task,
            now=_now_utc(),
            capabilities=self.capabilities,
            before_snapshots=self.before_snapshots,
            earlier_task_writes=self.earlier_task_writes,
            base_refs=self.base_refs,
            design_md=design_md,
            task_plan_yaml=task_plan_yaml,
            run_dir=self.run_dir,
        )

        # 处理 plan_amendment 信号 (自动 compute_rollback + apply + 回 PLANNING)
        if result.plan_amendments:
            for collected in result.plan_amendments:
                self.handle_plan_amendment(collected.outcome.plan_amendment)

        # 回填 completed task 的 key_diffs / task_check 结果给收口自检用
        for collected in result.completed_results:
            self._task_check_results[collected.task_id] = collected.task_check_result
            self._key_diffs_by_task[collected.task_id] = collected.outcome.key_diffs_file
            # 把 key-diffs 落盘到 tasks/<id>/key-diffs.yaml (若 worker 提交了)
            if collected.outcome.key_diffs_file is not None:
                kd_path = self.run_dir / "tasks" / collected.task_id / "key-diffs.yaml"
                kd_path.parent.mkdir(parents=True, exist_ok=True)
                collected.outcome.key_diffs_file.to_yaml_file(kd_path)
            # 落盘 summary.md
            summary_path = self.run_dir / "tasks" / collected.task_id / "summary.md"
            summary_path.parent.mkdir(parents=True, exist_ok=True)
            summary_path.write_text(
                collected.outcome.summary_text or "(empty summary)",
                encoding="utf-8",
            )
            # 建 task 目录 (init_task_dir)
            from .directory import init_task_dir
            init_task_dir(self.run_dir, collected.task_id)

        # 持久化 (tick 后)
        self._refresh_state_file()
        if self.plan is not None:
            self._refresh_plan_file()

        # 若所有 task 都 complete 且 phase=IMPLEMENTING → 自动 submit_wrap_up
        if (
            self.state.phase == Phase.IMPLEMENTING
            and self.plan is not None
            and all(t.status == "complete" for t in self.plan.tasks)
            and self.plan.tasks
        ):
            self.submit_wrap_up()

        return result

    def run_until_human_or_terminal(self, *, max_ticks: int = 100) -> None:
        """循环跑 tick, 直到 is_awaiting_human 或 is_terminal."""
        for _ in range(max_ticks):
            if is_terminal(self.state.phase):
                return
            if is_awaiting_human(self.state):
                return
            self.run_tick()
        # 达到 max_ticks 不算错误 (调用方可能继续), 但典型场景下应早于人/终态结束.

    # ------------------------------------------------------------------
    # plan amendment
    # ------------------------------------------------------------------
    def handle_plan_amendment(self, amendment: PlanAmendmentNeeded | None) -> None:
        """处理 plan-amendment: compute_rollback + apply + 回 PLANNING.

        changes_semantics=True (改了 AC 语义) → 回 PLANNING 等人重新拍板;
        changes_semantics=False (只 task 级回滚) → 留 IMPLEMENTING 让 coordinator 重派.
        """
        if amendment is None or self.plan is None:
            return
        rollback = compute_rollback(self.plan, amendment, changes_semantics=True)
        self.plan = apply_rollback(self.plan, rollback)
        # 把回滚摘要写到 tasks/<id>/logs/plan-amendment.txt
        if rollback.downgrade_to_pending or rollback.recall_to_pending:
            from ..amendment.rollback import summarize
            for tid in rollback.downgrade_to_pending + rollback.recall_to_pending:
                log_path = self.run_dir / "tasks" / tid / "logs" / "plan-amendment.txt"
                log_path.parent.mkdir(parents=True, exist_ok=True)
                log_path.write_text(summarize(rollback), encoding="utf-8")
        # changes_semantics=True → 回 PLANNING 等人重新拍板
        if rollback.changes_semantics and self.state.phase == Phase.IMPLEMENTING:
            self.state = advance_phase(self.state, Phase.PLANNING)
            self.state = set_human_pending(self.state, HumanPending.plan_signoff)
