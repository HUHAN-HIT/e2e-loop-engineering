"""CLI 入口 (argparse, design master-prompt §3).

子命令:
- init <requirement_file> [--complexity <auto|simple|medium|complex>]
- status [<run_id>]
- plan <run_id> --design <file> --task-plan <file>
- signoff-plan <run_id> [--reject --feedback <text>]
- run <run_id>
- wrap-up <run_id>
- signoff-wrap-up <run_id> [--reject]
- abort <run_id> --reason <text>
- amend <run_id> --reason <text> --ac <AC_ID>...

MVP: argparse + 子命令分发 + 调 Coordinator. InlineWorkerRunner 用 "echo" callback 占位.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .dispatch.worker_runner import InlineWorkerRunner, WorkerOutcome
from .runtime.coordinator import Coordinator
from .runtime.directory import (
    init_run_dir,
    next_run_id,
    read_run_state,
    write_run_state,
)
from .schema.run_state import Complexity, Phase, RunState
from .schema.task_plan import TaskPlan
from .claude_assets import install_claude_assets


def _echo_worker_callback(packet):
    """InlineWorkerRunner 占位 callback: 返回一个最小 completed outcome (空测试).

    真实场景下 callback 应 dispatch 真 LLM/worker. 这里只跑通骨架.
    """
    from .schema.artifacts import TestResults
    return WorkerOutcome(
        status="completed",
        test_results=TestResults(tests_green=True, cases=[]),
        summary_text=f"[echo] task {packet.task_id} done (placeholder worker)",
    )


def _resolve_run_dir(runs_root: Path, run_id: str) -> Path:
    """run_id → run_dir."""
    return runs_root / run_id


def cmd_init(args, runs_root: Path) -> int:
    """init 子命令: 建 run + 写 requirement.md + run-state.json."""
    req_path = Path(args.requirement_file)
    if not req_path.exists():
        print(f"错误: 需求文件不存在: {req_path}", file=sys.stderr)
        return 2
    requirement_text = req_path.read_text(encoding="utf-8")
    complexity = Complexity(args.complexity) if args.complexity != "auto" else Complexity.simple
    run_id = next_run_id(runs_root)
    run_dir = init_run_dir(runs_root, run_id, requirement_text)
    state = RunState(run_id=run_id, complexity=complexity, phase=Phase.CREATED)
    write_run_state(run_dir, state)
    print(f"created run: {run_id} at {run_dir}")
    print(f"phase: {state.phase.value}, complexity: {state.complexity.value}")
    return 0


def cmd_status(args, runs_root: Path) -> int:
    """status 子命令: 打印 phase / human_pending / active_tasks."""
    run_dir = _resolve_run_dir(runs_root, args.run_id)
    try:
        state = read_run_state(run_dir)
    except FileNotFoundError:
        print(f"错误: run-state.json 不存在: {run_dir}", file=sys.stderr)
        return 2
    print(f"run_id: {state.run_id}")
    print(f"phase: {state.phase.value}")
    print(f"complexity: {state.complexity.value}")
    print(f"trust_mode: {state.trust_mode.value}")
    print(f"human_pending: {state.human_pending.value if state.human_pending else '(none)'}")
    print(f"active_tasks: {state.active_tasks}")
    if state.aborted_at:
        print(f"aborted_at: {state.aborted_at}")
        print(f"aborted_reason: {state.aborted_reason}")
    return 0


def cmd_plan(args, runs_root: Path) -> int:
    """plan 子命令: 进入 PLANNING, 提交 design + task-plan, 跑 plan_check, set human_pending."""
    run_dir = _resolve_run_dir(runs_root, args.run_id)
    # 复制 design / task-plan 到 run_dir
    import shutil
    design_dst = run_dir / "planning" / "design.md"
    design_dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(args.design, design_dst)
    plan_dst = run_dir / "planning" / "task-plan.yaml"
    shutil.copyfile(args.task_plan, plan_dst)

    plan = TaskPlan.from_yaml_file(plan_dst)
    runner = InlineWorkerRunner(_echo_worker_callback)
    coord = Coordinator(run_dir, runner)
    if coord.state.phase == Phase.CREATED:
        coord.start_planning()
    coord.submit_plan(plan)
    print(f"run {args.run_id}: PLANNING 提交完成, phase={coord.state.phase.value}, "
          f"human_pending={coord.state.human_pending.value if coord.state.human_pending else '(none)'}")
    return 0


def cmd_signoff_plan(args, runs_root: Path) -> int:
    """signoff-plan 子命令."""
    run_dir = _resolve_run_dir(runs_root, args.run_id)
    runner = InlineWorkerRunner(_echo_worker_callback)
    coord = Coordinator(run_dir, runner)
    coord.signoff_plan(accepted=not args.reject, feedback=args.feedback or "")
    print(f"run {args.run_id}: plan signoff {'rejected' if args.reject else 'accepted'}, "
          f"phase={coord.state.phase.value}")
    return 0


def cmd_run(args, runs_root: Path) -> int:
    """run 子命令: IMPLEMENTING tick 循环, 跑到等人或终态."""
    run_dir = _resolve_run_dir(runs_root, args.run_id)
    runner = InlineWorkerRunner(_echo_worker_callback)
    coord = Coordinator(run_dir, runner)
    if coord.state.phase != Phase.IMPLEMENTING:
        print(f"错误: 当前 phase={coord.state.phase.value}, 必须 IMPLEMENTING 才能 run",
              file=sys.stderr)
        return 2
    coord.run_until_human_or_terminal(max_ticks=args.max_ticks)
    print(f"run {args.run_id}: 循环结束, phase={coord.state.phase.value}, "
          f"human_pending={coord.state.human_pending.value if coord.state.human_pending else '(none)'}")
    return 0


def cmd_wrap_up(args, runs_root: Path) -> int:
    """wrap-up 子命令: WRAPPING_UP 收口自检."""
    run_dir = _resolve_run_dir(runs_root, args.run_id)
    runner = InlineWorkerRunner(_echo_worker_callback)
    coord = Coordinator(run_dir, runner)
    coord.submit_wrap_up()
    print(f"run {args.run_id}: wrap-up 完成, phase={coord.state.phase.value}, "
          f"human_pending={coord.state.human_pending.value if coord.state.human_pending else '(none)'}")
    return 0


def cmd_signoff_wrap_up(args, runs_root: Path) -> int:
    """signoff-wrap-up 子命令."""
    run_dir = _resolve_run_dir(runs_root, args.run_id)
    runner = InlineWorkerRunner(_echo_worker_callback)
    coord = Coordinator(run_dir, runner)
    coord.signoff_wrap_up(accepted=not args.reject)
    print(f"run {args.run_id}: wrap-up signoff {'rejected' if args.reject else 'accepted'}, "
          f"phase={coord.state.phase.value}")
    return 0


def cmd_abort(args, runs_root: Path) -> int:
    """abort 子命令."""
    run_dir = _resolve_run_dir(runs_root, args.run_id)
    runner = InlineWorkerRunner(_echo_worker_callback)
    coord = Coordinator(run_dir, runner)
    coord.abort(args.reason)
    print(f"run {args.run_id}: ABORTED, reason={args.reason}")
    return 0


def cmd_install_claude(args, runs_root: Path) -> int:
    """install-claude 子命令: 同步 skill/agents/hooks/settings 到项目 .claude/."""
    del runs_root
    result = install_claude_assets(args.project_dir, force=args.force)
    print(f"installed Claude assets into: {result.project_dir / '.claude'}")
    print(f"installed: {len(result.installed)}, skipped: {len(result.skipped)}")
    if result.skipped and not args.force:
        print("已有文件已保留; 如需覆盖旧安装, 重新运行 --force")
    print(
        "提示: hooks 运行依赖 loop_engineering 包 (+pydantic/pyyaml); "
        "请确保运行 hook 的 python 环境已 `pip install loop-engineering`,"
    )
    print(
        "      否则 loop 运行期的 SSOT 校验不可用 "
        "(无活跃 run 时 hook 会自动放行, 不影响日常编辑)。"
    )
    return 0


def cmd_amend(args, runs_root: Path) -> int:
    """amend 子命令: 构造 PlanAmendmentNeeded 调 handle_plan_amendment."""
    from .schema.artifacts import PlanAmendmentNeeded
    run_dir = _resolve_run_dir(runs_root, args.run_id)
    runner = InlineWorkerRunner(_echo_worker_callback)
    coord = Coordinator(run_dir, runner)
    amendment = PlanAmendmentNeeded(
        reason=args.reason,
        touched_acceptance_refs=list(args.ac),
    )
    coord.handle_plan_amendment(amendment)
    coord._refresh_state_file()
    if coord.plan is not None:
        coord._refresh_plan_file()
    print(f"run {args.run_id}: amendment 已应用, phase={coord.state.phase.value}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    """构造 argparse parser."""
    parser = argparse.ArgumentParser(
        prog="loop_engineering",
        description="Loop Engineering 协作式多 agent 开发骨架 CLI",
    )
    parser.add_argument(
        "--runs-root",
        default="runs",
        help="runs 根目录 (默认 ./runs)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # init
    p_init = sub.add_parser("init", help="建 run, 写 input/requirement.md + run-state.json")
    p_init.add_argument("requirement_file", help="需求文件路径")
    p_init.add_argument(
        "--complexity",
        choices=["auto", "simple", "medium", "complex"],
        default="auto",
    )
    p_init.set_defaults(func=cmd_init)

    # status
    p_status = sub.add_parser("status", help="打印当前 phase / human_pending / active_tasks")
    p_status.add_argument("run_id")
    p_status.set_defaults(func=cmd_status)

    # plan
    p_plan = sub.add_parser("plan", help="进入 PLANNING, 提交 design + task-plan")
    p_plan.add_argument("run_id")
    p_plan.add_argument("--design", required=True)
    p_plan.add_argument("--task-plan", required=True)
    p_plan.set_defaults(func=cmd_plan)

    # signoff-plan
    p_sp = sub.add_parser("signoff-plan", help="人盯点 1")
    p_sp.add_argument("run_id")
    p_sp.add_argument("--reject", action="store_true")
    p_sp.add_argument("--feedback", default="")
    p_sp.set_defaults(func=cmd_signoff_plan)

    # run
    p_run = sub.add_parser("run", help="IMPLEMENTING tick 循环")
    p_run.add_argument("run_id")
    p_run.add_argument("--max-ticks", type=int, default=100)
    p_run.set_defaults(func=cmd_run)

    # wrap-up
    p_wu = sub.add_parser("wrap-up", help="WRAPPING_UP 收口自检")
    p_wu.add_argument("run_id")
    p_wu.set_defaults(func=cmd_wrap_up)

    # signoff-wrap-up
    p_sw = sub.add_parser("signoff-wrap-up", help="人盯点 2")
    p_sw.add_argument("run_id")
    p_sw.add_argument("--reject", action="store_true")
    p_sw.set_defaults(func=cmd_signoff_wrap_up)

    # abort
    p_ab = sub.add_parser("abort", help="→ ABORTED")
    p_ab.add_argument("run_id")
    p_ab.add_argument("--reason", required=True)
    p_ab.set_defaults(func=cmd_abort)

    # install-claude
    p_ic = sub.add_parser("install-claude", help="同步 Claude Code skill/agents/hooks/settings 到目标项目 .claude/")
    p_ic.add_argument("--project-dir", required=True, help="目标项目根目录; 必须显式指定, 避免误装到 loop-engineering 实现仓库")
    p_ic.add_argument("--force", action="store_true", help="覆盖已有 .claude 资产")
    p_ic.set_defaults(func=cmd_install_claude)

    # amend
    p_am = sub.add_parser("amend", help="处理 plan-amendment")
    p_am.add_argument("run_id")
    p_am.add_argument("--reason", required=True)
    p_am.add_argument("--ac", nargs="+", required=True, help="touched AC ids")
    p_am.set_defaults(func=cmd_amend)

    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI 入口. argparse + 子命令分发 + 调 Coordinator."""
    parser = build_parser()
    args = parser.parse_args(argv)
    runs_root = Path(args.runs_root)
    return args.func(args, runs_root)


if __name__ == "__main__":
    raise SystemExit(main())
