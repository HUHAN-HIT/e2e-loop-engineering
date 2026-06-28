"""A. PostToolUse:Task —— 防糊弄的物理保证 (design §0.2).

主 agent 通过 Task 工具收回 worker (clarification-finder / plan-agent /
implementation-worker / red-team-reviewer) 的结果时, 本 hook:

1. 从 subagent_type 判定 worker 类型.
2. 验证该 worker 必产出的 artifact 落盘且 schema 合法 (§0.4 artifact-first).
3. 对 implementation-worker: 用 git diff / fs snapshot 独立重算 actual_writes,
   覆盖 worker 自报告 (§0.2 防糊弄). tests_green 用 test-results.yaml 替换自报告.
4. 把 verified + actual_writes + warnings 作为 additionalContext 注入, 主 agent 读到的
   不再是 worker 原话, 而是机械重算结果.

block 条件 (artifact 缺失 / schema 不合法):
  → {"decision": "block", "reason": "worker <name> 未产出必需 artifact <path>; §0.4"}

warning 条件 (worker 自报告与 git diff 不一致):
  → 不 block, 在 additionalContext.warnings 里标红, 主 agent 决定是否重跑.
"""
from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path

import common
from common import (
    WORKER_CLARIFICATION,
    WORKER_IMPLEMENTATION,
    WORKER_PLAN,
    WORKER_RED_TEAM,
    additional_context,
    active_run_dir,
    classify_worker,
    emit,
    emit_block,
    emit_pass_silent,
    find_active_task,
    safe_read_run_state,
    safe_read_task_plan,
)


# ---------------------------------------------------------------------------
# 各 worker 必需 artifact 路径
# ---------------------------------------------------------------------------

def _impl_artifacts(run_dir: Path, task_id: str) -> dict[str, Path]:
    """implementation-worker 必产 artifact."""
    base = run_dir / "tasks" / task_id
    return {
        "test_results": base / "test-results.yaml",
        "summary": base / "summary.md",
        "key_diffs": base / "key-diffs.yaml",
    }


def _plan_artifacts(run_dir: Path) -> dict[str, Path]:
    return {
        "design": run_dir / "planning" / "design.md",
        "task_plan": run_dir / "planning" / "task-plan.yaml",
    }


def _clarification_artifacts(run_dir: Path) -> dict[str, Path]:
    return {
        "questions": run_dir / "clarification" / "questions.json",
    }


# ---------------------------------------------------------------------------
# SSOT 调用包装
# ---------------------------------------------------------------------------

def _read_test_results_yaml(path: Path):
    """读 test-results.yaml (SSOT 的 TestResults 默认是 json schema, 实际 worker 也可写 yaml).

    用 pydantic 模型校验. 失败 raise.
    """
    import yaml
    from loop_engineering.schema.artifacts import TestResults
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    return TestResults.model_validate(data)


def _recalc_actual_writes(run_dir: Path, task, capabilities):
    """用 SSOT collect_actual_writes 重算 actual_writes.

    走 git_diff 路径 (capabilities.git_diff=True 时), base_ref 取 HEAD (即未提交的工作树
    改动 + 已提交但相对 base 的改动). 没能力时回退空集 (后续 warning).
    """
    from loop_engineering.scheduling.actual_writes import collect_actual_writes
    workdir = common.REPO_ROOT
    base_ref = "HEAD" if capabilities and capabilities.git_diff else None
    return collect_actual_writes(
        workdir,
        task.id,
        capabilities,
        base_ref=base_ref,
        before_snapshot=None,
        after_snapshot=None,
        worker_self_report=[],
    )


# ---------------------------------------------------------------------------
# worker 分支处理
# ---------------------------------------------------------------------------

def _handle_implementation(tool_input, tool_response, run_dir, state, plan):
    """implementation-worker: 重算 actual_writes, 验证 artifact, 剥离自报告."""
    task = find_active_task(plan, state)
    if task is None:
        return emit_block(
            "implementation-worker 交回但找不到 status=running 的 task; "
            "无法定位 artifacts (§0.4 artifact-first)"
        )

    artifacts = _impl_artifacts(run_dir, task.id)
    missing = [str(p) for p in artifacts.values() if not p.is_file()]
    if missing:
        return emit_block(
            f"worker {WORKER_IMPLEMENTATION} 未产出必需 artifact {missing}; §0.4 artifact-first"
        )

    # 1. 解析 test-results.yaml (机械 tests_green)
    try:
        tr = _read_test_results_yaml(artifacts["test_results"])
    except Exception as e:  # noqa: BLE001
        return emit_block(
            f"test-results.yaml schema 不合法: {e}; §0.4 artifact-first"
        )

    # 2. 重算 actual_writes (§0.2 防糊弄核心)
    capabilities = state.capabilities if state and state.capabilities else None
    try:
        actual = _recalc_actual_writes(run_dir, task, capabilities)
    except Exception as e:  # noqa: BLE001
        # 重算失败不 block (避免能力缺失锁死), 但 warnings 标红
        actual = None
        warn = f"actual_writes 重算异常: {e}"
    else:
        warn = None

    # 3. 从 worker 自报告文本里粗匹配文件路径, 与 git diff 比对
    worker_text = _extract_worker_text(tool_response)
    self_report_paths = _extract_paths_from_text(worker_text)
    warnings: list[str] = []
    if actual is not None:
        git_paths = set(actual.writes)
        claimed_not_in_git = sorted(self_report_paths - git_paths)
        if claimed_not_in_git and actual.is_authoritative:
            warnings.append(
                f"worker 自报告写入但 git diff 未抓到: {claimed_not_in_git} "
                "(可能 worker 自报了但实际未落盘; §0.2 防糊弄)"
            )
        if actual.source == "worker_self_report":
            warnings.append(
                "actual_writes 来源=worker_self_report (宿主无 git/fs 能力), "
                "未做独立采集, 数据不可信; §0.2"
            )
    if warn:
        warnings.append(warn)

    # 4. tests_green: 用机械求值的 tr.tests_green, 不信 worker summary 里的字眼
    payload = {
        "verified": True,
        "worker": WORKER_IMPLEMENTATION,
        "task_id": task.id,
        "artifacts": {k: str(v) for k, v in artifacts.items()},
        "tests_green_mechanical": tr.tests_green,
        "tests_green_worker_self_report_stripped": True,
        "actual_writes": {
            "source": actual.source if actual else "unavailable",
            "is_authoritative": actual.is_authoritative if actual else False,
            "writes": actual.writes if actual else [],
        },
        "worker_self_report_paths_stripped_if_absent_from_git": True,
        "warnings": warnings,
    }
    return emit(additional_context(payload))


def _handle_plan(tool_input, tool_response, run_dir, state):
    """plan-agent: 验证 design.md / task-plan.yaml 存在 + plan_check 通过."""
    artifacts = _plan_artifacts(run_dir)
    missing = [str(p) for p in artifacts.values() if not p.is_file()]
    if missing:
        return emit_block(
            f"worker {WORKER_PLAN} 未产出必需 artifact {missing}; §0.4 artifact-first"
        )

    plan = safe_read_task_plan(run_dir)
    if plan is None:
        return emit_block(
            f"task-plan.yaml 解析失败; §0.4 artifact-first (路径={artifacts['task_plan']})"
        )

    # 调 SSOT plan_check
    try:
        from loop_engineering.scheduling.path_overlap import path_globs_overlap
        from loop_engineering.checklists.plan_check import check_plan
        result = check_plan(plan, path_overlap_fn=path_globs_overlap)
    except Exception as e:  # noqa: BLE001
        return emit_block(f"plan_check 调用异常: {e}")

    warnings = [f"{i.check}: {i.detail}" for i in result.items if not i.passed]
    payload = {
        "verified": result.all_pass,
        "worker": WORKER_PLAN,
        "artifacts": {k: str(v) for k, v in artifacts.items()},
        "plan_check_all_pass": result.all_pass,
        "warnings": warnings,
    }
    if not result.all_pass:
        # 不 block (plan-agent 之后还有 plan_signoff 人工锚点), 但 verified=False
        payload["note"] = "plan_check 未全过; 主 agent 须据 warnings 决定是否重跑 plan-agent"
    return emit(additional_context(payload))


def _handle_clarification(tool_input, tool_response, run_dir):
    """clarification-finder: 验证 questions.json 存在且非空."""
    artifacts = _clarification_artifacts(run_dir)
    missing = [str(p) for p in artifacts.values() if not p.is_file()]
    if missing:
        return emit_block(
            f"worker {WORKER_CLARIFICATION} 未产出必需 artifact {missing}; §0.4 artifact-first"
        )
    try:
        data = json.loads(artifacts["questions"].read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        return emit_block(f"questions.json schema 不合法: {e}")
    questions = data.get("questions") if isinstance(data, dict) else data
    if not questions:
        return emit_block("questions.json 为空; clarification-finder 必须产出 ≥1 问题")
    payload = {
        "verified": True,
        "worker": WORKER_CLARIFICATION,
        "artifacts": {k: str(v) for k, v in artifacts.items()},
        "question_count": len(questions),
        "warnings": [],
    }
    return emit(additional_context(payload))


def _handle_red_team(tool_input, tool_response, run_dir):
    """red-team-reviewer: 验证产物 (放在 wrap-up/red-team-review.md)."""
    p = run_dir / "wrap-up" / "red-team-review.md"
    if not p.is_file():
        return emit_block(
            f"worker {WORKER_RED_TEAM} 未产出必需 artifact [{p}]; §0.4 artifact-first"
        )
    payload = {
        "verified": True,
        "worker": WORKER_RED_TEAM,
        "artifacts": {"red_team_review": str(p)},
        "warnings": [],
    }
    return emit(additional_context(payload))


# ---------------------------------------------------------------------------
# worker 输出文本提取 (不信任)
# ---------------------------------------------------------------------------

def _extract_worker_text(tool_response) -> str:
    """从 Task tool 的 response 里尽量抽出 worker 输出文本."""
    if not isinstance(tool_response, dict):
        return str(tool_response or "")
    for key in ("result", "content", "output", "text", "stdout"):
        v = tool_response.get(key)
        if isinstance(v, str) and v.strip():
            return v
    # 兜底: 整个 response 序列化
    try:
        return json.dumps(tool_response, ensure_ascii=False)
    except Exception:  # noqa: BLE001
        return str(tool_response)


def _extract_paths_from_text(text: str) -> set[str]:
    """从 worker 自报告文本里粗抓文件路径 (用于与 git diff 比对的 warning).

    只抓形如 foo/bar.py / foo\\bar.py 的相对路径, 不抓绝对路径 / 单文件名.
    返回 POSIX 化的相对路径集合.
    """
    import re
    out: set[str] = set()
    # 匹配 a/b.c 或 a\b.c 形式 (至少一个分隔符 + 后缀)
    pat = re.compile(r"[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+\.[A-Za-z0-9]+")
    for m in pat.findall(text or ""):
        out.add(m.replace("\\", "/"))
    return out


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------

def main() -> int:
    try:
        payload = common.read_stdin_json()
        tool_input = payload.get("tool_input") or {}
        tool_response = payload.get("tool_response") or {}

        worker = classify_worker(tool_input)
        if worker is None:
            # 非 loop-engineering worker 的 Task 调用: 静默放行 (不干扰其它用法)
            emit_pass_silent()
            return 0

        run_dir = active_run_dir()
        if run_dir is None:
            return emit_block(
                f"worker {worker} 交回但找不到活跃 run 目录 (runs/ 下无子目录); "
                "§0.4 artifact-first 要求先 init_run_dir"
            )

        state = safe_read_run_state(run_dir)
        plan = safe_read_task_plan(run_dir) if worker == WORKER_IMPLEMENTATION else None

        if worker == WORKER_IMPLEMENTATION:
            return _handle_implementation(tool_input, tool_response, run_dir, state, plan)
        if worker == WORKER_PLAN:
            return _handle_plan(tool_input, tool_response, run_dir, state)
        if worker == WORKER_CLARIFICATION:
            return _handle_clarification(tool_input, tool_response, run_dir)
        if worker == WORKER_RED_TEAM:
            return _handle_red_team(tool_input, tool_response, run_dir)

        emit_pass_silent()
        return 0
    except Exception as e:  # noqa: BLE001
        # fail-safe: hook 内部异常时 block, 不静默放过
        tb = traceback.format_exc()
        emit_block(f"post_task_collect hook 内部错误: {e}\n{tb}")
        return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
