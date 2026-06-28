"""C. Stop —— 人工锚点 + §8 完成定义 (design §1 / §2 / §8).

主 agent 准备结束回合时:
- 无活跃 run → 通过 (用户在做别的事).
- phase = COMPLETE / ABORTED → 通过.
- human_pending != None (三类人盯点: clarification / plan_signoff / wrap_up_signoff)
  → 通过 (这就是合法人工锚点, 等人介入).
- 否则跑对应 phase 的 §2.x 自检:
    PLANNING     → check_plan (plan 自检)
    IMPLEMENTING → check_task (当前活跃 task 的任务自检)
    WRAPPING_UP  → check_wrap_up (收口自检)
  自检通过 → 通过; 自检不过 → block (要求 agent 继续推进到合法锚点).
"""
from __future__ import annotations

import sys
import traceback

import common
from common import (
    emit_block,
    emit_pass_silent,
    find_active_task,
    safe_read_run_state,
    safe_read_task_plan,
)


def _phase_value(state) -> str:
    if state is None:
        return ""
    ph = getattr(state, "phase", "")
    return getattr(ph, "value", str(ph))


def _human_pending_value(state) -> str:
    hp = getattr(state, "human_pending", None)
    if hp is None:
        return ""
    return getattr(hp, "value", str(hp))


# ---------------------------------------------------------------------------
# 各 phase 自检
# ---------------------------------------------------------------------------

def _check_planning_phase(run_dir):
    """PLANNING phase: 跑 plan_check."""
    plan = safe_read_task_plan(run_dir)
    if plan is None:
        return False, "PLANNING 但 task-plan.yaml 缺失或不可解析"
    try:
        from loop_engineering.scheduling.path_overlap import path_globs_overlap
        from loop_engineering.checklists.plan_check import check_plan
        result = check_plan(plan, path_overlap_fn=path_globs_overlap)
    except Exception as e:  # noqa: BLE001
        return False, f"plan_check 调用异常: {e}"
    if result.all_pass:
        return True, "plan_check 全过"
    detail = "; ".join(f"{i.check}={i.detail}" for i in result.items if not i.passed)
    return False, f"plan_check 未全过: {detail}"


def _check_implementing_phase(run_dir, state, plan):
    """IMPLEMENTING phase: 当前活跃 task 的任务自检.

    简化策略: 只检查"是否有 status=running 的 task"且其 test-results.yaml 已落盘且
    tests_green (机械求值). 完整 task_check 需要 WorkerOutcome 等, hook 里不便重建,
    这里走轻量校验.
    """
    if plan is None:
        return False, "IMPLEMENTING 但 task-plan.yaml 缺失"
    task = find_active_task(plan, state)
    if task is None:
        # 没有 running 的 task, 可能是 task 间过渡 → 放行
        return True, "无 status=running 的 task (过渡态)"
    tr_path = run_dir / "tasks" / task.id / "test-results.yaml"
    if not tr_path.is_file():
        return False, (
            f"task {task.id} status=running 但 test-results.yaml 未落盘; "
            "task 未完成不应停止 (§0.4 artifact-first)"
        )
    try:
        import yaml
        from loop_engineering.schema.artifacts import TestResults
        data = yaml.safe_load(tr_path.read_text(encoding="utf-8"))
        tr = TestResults.model_validate(data)
    except Exception as e:  # noqa: BLE001
        return False, f"task {task.id} test-results.yaml 解析失败: {e}"
    if not tr.tests_green:
        return False, (
            f"task {task.id} tests_green=False (机械求值), 未到 task 完成锚点"
        )
    return True, f"task {task.id} 自检通过"


def _check_wrap_up_phase(run_dir, state):
    """WRAPPING_UP phase: 跑 wrap_up_check (简化: 仅查所有 task 自检 + key-diffs)."""
    plan = safe_read_task_plan(run_dir)
    if plan is None:
        return False, "WRAPPING_UP 但 task-plan.yaml 缺失"
    try:
        from loop_engineering.checklists.task_check import TaskCheckResult, TaskCheckItem
        from loop_engineering.checklists.wrap_up_check import check_wrap_up
        from loop_engineering.schema.artifacts import KeyDiffsFile
    except Exception as e:  # noqa: BLE001
        return False, f"SSOT import 失败: {e}"

    # 收集每个 task 的 task_check_result (从 test-results.yaml 重建简化版) + key_diffs
    task_results = {}
    key_diffs_by_task = {}
    for t in plan.tasks:
        tr_path = run_dir / "tasks" / t.id / "test-results.yaml"
        if not tr_path.is_file():
            continue
        try:
            import yaml
            from loop_engineering.schema.artifacts import TestResults
            tr = TestResults.model_validate(yaml.safe_load(tr_path.read_text(encoding="utf-8")))
            task_results[t.id] = TaskCheckResult(
                task_id=t.id,
                items=[TaskCheckItem(check="tests_green", passed=tr.tests_green)],
            )
        except Exception:  # noqa: BLE001
            pass
        kd_path = run_dir / "tasks" / t.id / "key-diffs.yaml"
        if kd_path.is_file():
            try:
                key_diffs_by_task[t.id] = KeyDiffsFile.from_yaml_file(kd_path)
            except Exception:  # noqa: BLE001
                key_diffs_by_task[t.id] = None

    try:
        result = check_wrap_up(plan, task_results, key_diffs_by_task)
    except Exception as e:  # noqa: BLE001
        return False, f"wrap_up_check 调用异常: {e}"
    if result.all_pass:
        return True, "wrap_up_check 全过"
    detail = "; ".join(f"{i.check}={i.detail}" for i in result.items if not i.passed)
    return False, f"wrap_up_check 未全过: {detail}"


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------

def main() -> int:
    try:
        payload = common.read_stdin_json()
        # 无 tool_input; hook 只看 session / transcript
        run_dir = common.active_run_dir()
        if run_dir is None:
            emit_pass_silent()
            return 0

        state = safe_read_run_state(run_dir)
        if state is None:
            # run 目录存在但 run-state.json 缺失 → 不归本 hook 管
            emit_pass_silent()
            return 0

        phase = _phase_value(state)
        if phase in ("COMPLETE", "ABORTED", ""):
            emit_pass_silent()
            return 0

        hp = _human_pending_value(state)
        if hp in ("clarification", "plan_signoff", "wrap_up_signoff"):
            # 合法人工锚点: 等人介入, 放行
            emit_pass_silent()
            return 0

        plan = safe_read_task_plan(run_dir)

        if phase == "CREATED":
            # CREATED: 允许 agent 直接进 clarification / planning
            emit_pass_silent()
            return 0
        if phase == "CLARIFYING":
            # CLARIFYING 但 human_pending=None → 自动模式, 允许 agent 继续推进
            emit_pass_silent()
            return 0
        if phase == "PLANNING":
            ok, detail = _check_planning_phase(run_dir)
        elif phase == "IMPLEMENTING":
            ok, detail = _check_implementing_phase(run_dir, state, plan)
        elif phase == "WRAPPING_UP":
            ok, detail = _check_wrap_up_phase(run_dir, state)
        else:
            emit_pass_silent()
            return 0

        if ok:
            emit_pass_silent()
            return 0
        return emit_block(
            f"phase={phase} 未到合法锚点且自检未过: {detail}. "
            "必须先到达 plan_signoff 或 wrap_up_signoff 锚点 (§1 / §8)."
        )
    except Exception as e:  # noqa: BLE001
        tb = traceback.format_exc()
        # Stop hook 异常 fail-safe: 不锁死 agent, 但提示有错
        emit_block(f"guard_anchors hook 内部错误: {e}\n{tb}")
        return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
