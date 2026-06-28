"""loop-engineering hooks 公共底座.

统一处理: stdin JSON 解析 / sys.path 注入 / 仓库根定位 / run 目录定位 /
run-state / task-plan 读取. 4 个 hook 共用, 避免重复.

设计原则:
- 失败 fail-safe: hook 内部异常时, 写明确 block reason (除了 SessionStart 退化放行,
  避免锁死整个会话).
- 不重写算法: 所有 actual_writes / 检查 / 能力探测全部走 loop_engineering SSOT.
- 中文注释, 与 SSOT 风格一致 (design §0.4 artifact-first / §0.2 防糊弄).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# sys.path 注入: 让 hook 能 import loop_engineering
# ---------------------------------------------------------------------------

def _repo_root() -> Path:
    """定位仓库根 (含 .claude/ 的目录).

    优先级:
    1. CLAUDE_PROJECT_DIR 环境变量 (Claude Code 注入).
    2. 从本文件位置上溯找 .claude/.
    3. cwd 上溯找 .claude/.
    全部失败时返回 cwd (后续读取会自然报错, fail-safe 在 hook 主逻辑里).
    """
    env = os.environ.get("CLAUDE_PROJECT_DIR")
    if env:
        p = Path(env).resolve()
        if (p / ".claude").is_dir():
            return p

    here = Path(__file__).resolve()
    for parent in [here, *here.parents]:
        if (parent / ".claude").is_dir():
            return parent

    cwd = Path.cwd()
    for parent in [cwd, *cwd.parents]:
        if (parent / ".claude").is_dir():
            return parent
    return cwd


REPO_ROOT = _repo_root()

# 让 hook 能 import loop_engineering. 支持源码 checkout、旧 outputs 布局、以及 pip 安装布局。
def _candidate_import_roots() -> list[Path]:
    here = Path(__file__).resolve()
    candidates: list[Path] = []
    for parent in [here.parent, *here.parents]:
        if (parent / "loop_engineering" / "__init__.py").is_file():
            candidates.append(parent)
    candidates.append(REPO_ROOT)
    candidates.append(REPO_ROOT / "outputs" / "loop_engineering")

    out: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        if not (candidate / "loop_engineering").is_dir():
            continue
        key = str(candidate)
        if key in seen:
            continue
        seen.add(key)
        out.append(candidate)
    return out


for _root in reversed(_candidate_import_roots()):
    _root_s = str(_root)
    if _root_s not in sys.path:
        sys.path.insert(0, _root_s)


# ---------------------------------------------------------------------------
# stdin / stdout 协议
# ---------------------------------------------------------------------------

def read_stdin_json() -> dict[str, Any]:
    """读 stdin 的 hook payload. 空 stdin → {}."""
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        # 不 raise, 让调用方拿到 {} 后再决定是否 fail-safe
        sys.stderr.write(f"[hook common] stdin JSON 解析失败: {e}\n")
        return {}


def emit(payload: dict[str, Any]) -> None:
    """stdout 输出 JSON, 单行."""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


def emit_block(reason: str) -> None:
    """便捷: 输出 block 决策."""
    emit({"decision": "block", "reason": reason})


def emit_pass_silent() -> None:
    """便捷: 静默放行 (输出空 JSON)."""
    emit({})


# ---------------------------------------------------------------------------
# run 目录定位
# ---------------------------------------------------------------------------

def runs_root() -> Path:
    """runs/ 根目录. 默认在仓库根下; 可用 LOOP_RUNS_ROOT 环境变量覆盖."""
    env = os.environ.get("LOOP_RUNS_ROOT")
    if env:
        return Path(env).resolve()
    return REPO_ROOT / "runs"


def active_run_dir() -> Path | None:
    """当前活跃 run 目录: runs/ 下最新 mtime 的子目录.

    没有任何 run 子目录时返回 None.
    """
    root = runs_root()
    if not root.is_dir():
        return None
    candidates = [p for p in root.iterdir() if p.is_dir()]
    if not candidates:
        return None
    # 最新 mtime (注意: 写状态文件会刷新 mtime, 最近的 run 通常最热)
    return max(candidates, key=lambda p: p.stat().st_mtime_ns)


def run_state_path(run_dir: Path) -> Path:
    """run-state.json 路径 (SSOT 用 .json, 不是 .yaml)."""
    return run_dir / "run-state.json"


def task_plan_path(run_dir: Path) -> Path:
    return run_dir / "planning" / "task-plan.yaml"


# ---------------------------------------------------------------------------
# SSOT 包装 (薄适配, 不重写算法)
# ---------------------------------------------------------------------------

def safe_read_run_state(run_dir: Path):
    """读 RunState, 失败返回 None (调用方决定 fail-safe)."""
    try:
        from loop_engineering.runtime.directory import read_run_state
        return read_run_state(run_dir)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"[hook common] 读 run-state 失败: {e}\n")
        return None


def safe_read_task_plan(run_dir: Path):
    """读 TaskPlan, 失败返回 None."""
    p = task_plan_path(run_dir)
    if not p.is_file():
        return None
    try:
        from loop_engineering.schema.task_plan import TaskPlan
        return TaskPlan.from_yaml_file(p)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"[hook common] 读 task-plan 失败: {e}\n")
        return None


def find_active_task(plan, state):
    """从 plan + state 找当前 status=running 的 task.

    state.active_tasks 给的是 task_id 列表; plan 给全量. 优先取 plan 里 status=running
    且在 state.active_tasks 中的. 多个时取第一个. 找不到返回 None.
    """
    if plan is None:
        return None
    active_ids = set(state.active_jobs()) if state is not None and hasattr(state, "active_jobs") else set()
    if state is not None:
        active_ids = set(getattr(state, "active_tasks", []) or [])
    for t in plan.tasks:
        if str(t.status) == "running" or getattr(t.status, "value", "") == "running":
            # 若 state.active_tasks 有内容, 进一步校验; 否则 plan 里 running 即活跃
            if not active_ids or t.id in active_ids:
                return t
    return None


# ---------------------------------------------------------------------------
# 输出构建辅助
# ---------------------------------------------------------------------------

def additional_context(payload: dict[str, Any]) -> dict[str, Any]:
    """构造 PostToolUse / SessionStart 的 additionalContext 输出包."""
    return {"hookSpecificOutput": {"additionalContext": json.dumps(payload, ensure_ascii=False)}}


# ---------------------------------------------------------------------------
# 4 类 worker 的 subagent_type 标识 (与 .claude/agents/<name>.md 对应)
# ---------------------------------------------------------------------------

WORKER_IMPLEMENTATION = "implementation-worker"
WORKER_PLAN = "plan-agent"
WORKER_CLARIFICATION = "clarification-finder"
WORKER_RED_TEAM = "red-team-reviewer"


def classify_worker(tool_input: dict[str, Any]) -> str | None:
    """从 Task 工具的 tool_input 推断 worker 类型.

    Task tool 的 subagent_type 字段对应 .claude/agents/<name>.md 的文件名 stem.
    无匹配返回 None.
    """
    st = (tool_input or {}).get("subagent_type") or ""
    # 兼容大小写 / 前缀
    st_lc = str(st).lower()
    if WORKER_IMPLEMENTATION in st_lc:
        return WORKER_IMPLEMENTATION
    if WORKER_PLAN in st_lc:
        return WORKER_PLAN
    if WORKER_CLARIFICATION in st_lc or "clarification" in st_lc:
        return WORKER_CLARIFICATION
    if WORKER_RED_TEAM in st_lc or "red" in st_lc:
        return WORKER_RED_TEAM
    return None
