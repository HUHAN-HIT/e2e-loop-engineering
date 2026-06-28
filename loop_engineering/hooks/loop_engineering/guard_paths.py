"""B. PreToolUse:Write/Edit —— 路径白名单 (design §0.4 artifact-first).

任何 Write / Edit 调用前, 按目标 file_path 前缀判定合法性. 当前 phase + 当前活跃
task 决定哪些路径可写.

规则 (按 file_path 前缀匹配, 第一个命中生效):
1. <repo>/.claude/**              → 永远 deny (保护 skill/agent/hook 自身)
2. <repo>/runs/<id>/run-state.*   → 永远 allow (协调者写状态)
3. <repo>/runs/<id>/tasks/<tid>/** → 仅当 <tid> 是当前活跃 run 里 status=running 的 task
4. <repo>/runs/<id>/planning/**   → 仅在 phase ∈ {CREATED, CLARIFYING, PLANNING}
5. <repo>/runs/<id>/clarification/** → 仅在 phase ∈ {CREATED, CLARIFYING}
6. <repo>/runs/<id>/wrap-up/**    → 仅在 phase = WRAPPING_UP
7. <repo>/** (排除上述)           → 仅在 phase = IMPLEMENTING 且当前活跃 task 的
                                     allowed_write_paths 覆盖该路径
8. 其它                            → deny

deny 时返回 {"decision": "block", "reason": "..."}.
"""
from __future__ import annotations

import os
import sys
import traceback
from pathlib import Path
from urllib.parse import unquote

import common
from common import (
    emit_block,
    emit_pass_silent,
    find_active_task,
    safe_read_run_state,
    safe_read_task_plan,
)


def _normalize_file_path(tool_input) -> Path | None:
    """从 tool_input 取 file_path 并规范化 (处理 file:// URL / 相对路径)."""
    fp = (tool_input or {}).get("file_path") or (tool_input or {}).get("path")
    if not fp:
        return None
    s = str(fp)
    if s.startswith("file://"):
        s = unquote(s[len("file://"):])
    # Windows 盘符 / POSIX 都接受
    p = Path(s)
    if not p.is_absolute():
        p = (common.REPO_ROOT / p).resolve()
    try:
        return p.resolve()
    except Exception:  # noqa: BLE001
        return p


def _rel_to_repo(p: Path) -> str | None:
    """返回相对 REPO_ROOT 的 POSIX 路径; 不在 repo 内返回 None."""
    try:
        rel = p.resolve().relative_to(common.REPO_ROOT.resolve())
        return rel.as_posix()
    except Exception:  # noqa: BLE001
        return None


def _phase_value(state) -> str:
    if state is None:
        return ""
    ph = getattr(state, "phase", "")
    return getattr(ph, "value", str(ph))


# ---------------------------------------------------------------------------
# 规则
# ---------------------------------------------------------------------------

def _rule_claude(rel: str) -> str | None:
    """规则 1: .claude/** 永远 deny."""
    if rel == ".claude" or rel.startswith(".claude/"):
        return "保护 .claude/ (skill/agent/hook 自身) — 仅用户手工编辑, agent 不可写"
    return None


def _rule_run_state(rel: str) -> str | None:
    """规则 2: runs/<id>/run-state.* 允许."""
    parts = rel.split("/")
    if len(parts) >= 2 and parts[0] == "runs":
        # runs/<id>/run-state.json (SSOT 实际是 .json)
        if len(parts) == 3 and parts[2].startswith("run-state."):
            return "ALLOW"
    return None


def _rule_tasks(rel: str, plan, state) -> str | None:
    """规则 3: runs/<id>/tasks/<tid>/**, tid 必须是活跃 task."""
    parts = rel.split("/")
    if len(parts) >= 4 and parts[0] == "runs" and parts[2] == "tasks":
        tid = parts[3]
        # 必须 status=running 才允许
        active = find_active_task(plan, state)
        if active is not None and active.id == tid:
            return "ALLOW"
        return (
            f"runs/.../tasks/{tid}/ 写入被拒: 该 task 不是当前活跃 run 里 "
            f"status=running 的 task (§0.4 artifact-first)"
        )
    return None


def _rule_planning(rel: str, phase: str) -> str | None:
    """规则 4: runs/<id>/planning/**, phase ∈ {CREATED, CLARIFYING, PLANNING}."""
    parts = rel.split("/")
    if len(parts) >= 3 and parts[0] == "runs" and parts[2] == "planning":
        if phase in {"CREATED", "CLARIFYING", "PLANNING"}:
            return "ALLOW"
        return (
            f"planning/ 写入被拒: 当前 phase={phase}, 仅 CREATED/CLARIFYING/PLANNING 可写"
        )
    return None


def _rule_clarification(rel: str, phase: str) -> str | None:
    """规则 5: runs/<id>/clarification/**, phase ∈ {CREATED, CLARIFYING}."""
    parts = rel.split("/")
    if len(parts) >= 3 and parts[0] == "runs" and parts[2] == "clarification":
        if phase in {"CREATED", "CLARIFYING"}:
            return "ALLOW"
        return (
            f"clarification/ 写入被拒: 当前 phase={phase}, 仅 CREATED/CLARIFYING 可写"
        )
    return None


def _rule_wrap_up(rel: str, phase: str) -> str | None:
    """规则 6: runs/<id>/wrap-up/**, phase = WRAPPING_UP."""
    parts = rel.split("/")
    if len(parts) >= 3 and parts[0] == "runs" and parts[2] == "wrap-up":
        if phase == "WRAPPING_UP":
            return "ALLOW"
        return f"wrap-up/ 写入被拒: 当前 phase={phase}, 仅 WRAPPING_UP 可写"
    return None


def _rule_source(rel: str, phase: str, active_task) -> str | None:
    """规则 7: 仓库源码 (排除上面 6 类), 仅 IMPLEMENTING 且 active task 覆盖.

    与 runs/ 路径互斥 (本函数只在前面 6 条都没命中时被调).
    """
    # 不是 runs/ 内的文件 = 源码 / 配置 / 测试 等
    if rel.startswith("runs/"):
        # runs/ 下但没被前 6 条匹配 (如 runs/<id>/ 不规范路径) → deny
        return f"runs/ 内未识别子路径: {rel}"
    if rel.startswith("loop_engineering/") or rel.startswith("outputs/loop_engineering/"):
        return "保护 Python SSOT (loop_engineering/ 或旧 outputs/loop_engineering/) — 不可改"
    if phase != "IMPLEMENTING":
        return (
            f"源码写入被拒: 当前 phase={phase}, 仅 IMPLEMENTING 可写源码 "
            "(§0.4 artifact-first)"
        )
    if active_task is None:
        return "源码写入被拒: IMPLEMENTING 但找不到 status=running 的 task"
    # 检查 task.allowed_write_paths 是否覆盖目标
    try:
        from loop_engineering.scheduling.path_overlap import path_globs_overlap
        if path_globs_overlap([rel], list(active_task.allowed_write_paths)):
            return "ALLOW"
    except Exception as e:  # noqa: BLE001
        return f"path_overlap 检查异常: {e}"
    return (
        f"源码写入被拒: 路径 {rel} 不在当前 task {active_task.id} 的 "
        f"allowed_write_paths={list(active_task.allowed_write_paths)} 范围内"
    )


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------

def main() -> int:
    try:
        payload = common.read_stdin_json()
        tool_input = payload.get("tool_input") or {}
        p = _normalize_file_path(tool_input)
        if p is None:
            # 无 file_path 的 Write/Edit (理论不存在), 静默放行
            emit_pass_silent()
            return 0

        rel = _rel_to_repo(p)
        if rel is None:
            # 仓库外写入 (临时文件等), 不归本 hook 管
            emit_pass_silent()
            return 0

        run_dir = common.active_run_dir()
        state = safe_read_run_state(run_dir) if run_dir is not None else None
        plan = safe_read_task_plan(run_dir) if run_dir is not None else None
        phase = _phase_value(state)

        # 仅在存在"治理中的活跃 run"时才执行写路径白名单; 否则一律静默放行:
        #   - 无 run (runs/ 空 / 未 init)          → 普通项目的日常编辑, 不该被拦 (修复 #1)
        #   - run-state 缺失/不可解析 / loop_engineering SSOT 不可导入
        #     (safe_read_run_state 返回 None)      → 无法可靠治理, 退化放行 (兼顾 #2 缺包)
        #   - phase ∈ {COMPLETE, ABORTED, ""}      → run 已终态, 不再治理写入
        # 这样装进真实项目后, loop 之外的编辑不受影响; 只有 run 进行中才收紧。
        GOVERNING_PHASES = {"CREATED", "CLARIFYING", "PLANNING", "IMPLEMENTING", "WRAPPING_UP"}
        if run_dir is None or state is None or phase not in GOVERNING_PHASES:
            emit_pass_silent()
            return 0

        # 规则 1: .claude/** (仅在 run 治理期保护 skill/agent/hook 自身不被 worker 改)
        msg = _rule_claude(rel)
        if msg is not None:
            if msg == "ALLOW":
                emit_pass_silent()
                return 0
            return emit_block(f"路径白名单拒绝: {p} ({msg})")

        # 规则 2: run-state.*
        msg = _rule_run_state(rel)
        if msg is not None:
            if msg == "ALLOW":
                emit_pass_silent()
                return 0
            return emit_block(f"路径白名单拒绝: {p} ({msg})")

        # 规则 3: tasks/<tid>/**
        msg = _rule_tasks(rel, plan, state)
        if msg is not None:
            if msg == "ALLOW":
                emit_pass_silent()
                return 0
            return emit_block(f"路径白名单拒绝: {p} ({msg})")

        # 规则 4: planning/**
        msg = _rule_planning(rel, phase)
        if msg is not None:
            if msg == "ALLOW":
                emit_pass_silent()
                return 0
            return emit_block(f"路径白名单拒绝: {p} ({msg})")

        # 规则 5: clarification/**
        msg = _rule_clarification(rel, phase)
        if msg is not None:
            if msg == "ALLOW":
                emit_pass_silent()
                return 0
            return emit_block(f"路径白名单拒绝: {p} ({msg})")

        # 规则 6: wrap-up/**
        msg = _rule_wrap_up(rel, phase)
        if msg is not None:
            if msg == "ALLOW":
                emit_pass_silent()
                return 0
            return emit_block(f"路径白名单拒绝: {p} ({msg})")

        # 规则 7: 源码
        active = find_active_task(plan, state) if phase == "IMPLEMENTING" else None
        msg = _rule_source(rel, phase, active)
        if msg == "ALLOW":
            emit_pass_silent()
            return 0
        return emit_block(f"路径白名单拒绝: {p} ({msg})")
    except Exception as e:  # noqa: BLE001
        tb = traceback.format_exc()
        emit_block(f"guard_paths hook 内部错误: {e}\n{tb}")
        return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
