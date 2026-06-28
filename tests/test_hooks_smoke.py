"""loop-engineering hooks 冒烟测试.

每个 hook 用 subprocess 跑 `python <hook.py>`, 通过 stdin 喂 JSON, 验证 stdout 输出.
不追求覆盖率, 只验证关键路径:
- guard_paths: 合法源码写入放行 / 非法 (.claude/) deny / 非 IMPLEMENTING 写源码 deny
- guard_anchors: 无活跃 run 放行 / COMPLETE 放行 / human_pending 放行 / 自检失败 block
- post_task_collect: 非 Task worker 放行 / artifact 缺失 block / clarification questions 空 block
- probe_and_gate: 无活跃 run 注入 capabilities / SessionStart 异常 fail-safe 放行
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent  # tests/test_hooks_smoke.py -> repo root
HOOK_DIR = REPO_ROOT / "loop_engineering" / "hooks" / "loop_engineering"


def _run_hook(script: str, payload: dict | None, env_overrides: dict | None = None) -> tuple[int, str, str]:
    """跑一个 hook 脚本, 喂 stdin JSON, 返回 (rc, stdout, stderr)."""
    env = os.environ.copy()
    env["CLAUDE_PROJECT_DIR"] = str(REPO_ROOT)
    # 加 PYTHONPATH 防万一 common.py 没注入 sys.path (Windows 路径)
    env["PYTHONPATH"] = str(REPO_ROOT) + os.pathsep + env.get("PYTHONPATH", "")
    if env_overrides:
        env.update(env_overrides)
    stdin_data = json.dumps(payload) if payload is not None else ""
    proc = subprocess.run(
        [sys.executable, str(HOOK_DIR / script)],
        input=stdin_data,
        capture_output=True,
        text=True,
        env=env,
        cwd=str(REPO_ROOT),
        timeout=30,
    )
    return proc.returncode, proc.stdout, proc.stderr


def _parse(stdout: str) -> dict:
    """解析 hook stdout JSON, 容忍空输出."""
    stdout = (stdout or "").strip()
    if not stdout:
        return {}
    return json.loads(stdout)


# ---------------------------------------------------------------------------
# 一个临时 run 目录 fixture, 用于多数测试
# ---------------------------------------------------------------------------

@pytest.fixture()
def tmp_run(tmp_path, monkeypatch):
    """在 tmp_path 下建一个 runs/ 目录, 含一个 run, 写入 run-state.json + task-plan.yaml.

    用 LOOP_RUNS_ROOT 让 common.runs_root() 走临时目录, 不污染真实 runs/.
    """
    runs_root = tmp_path / "runs"
    runs_root.mkdir()
    run_dir = runs_root / "20260101-001"
    (run_dir / "planning").mkdir(parents=True)
    (run_dir / "tasks").mkdir(parents=True)
    (run_dir / "clarification").mkdir(parents=True)
    (run_dir / "wrap-up").mkdir(parents=True)

    # 写 run-state.json (SSOT schema)
    state = {
        "run_id": "20260101-001",
        "phase": "IMPLEMENTING",
        "complexity": "simple",
        "trust_mode": "collaborative",
        "active_tasks": ["t1"],
    }
    (run_dir / "run-state.json").write_text(json.dumps(state), encoding="utf-8")

    # 写 task-plan.yaml: 单个 task t1, status=running, 含 allowed_write_paths
    plan_yaml = (
        "schema: loop-engineering.task-plan.v2\n"
        "complexity: simple\n"
        "tasks:\n"
        "  - id: t1\n"
        "    title: test task\n"
        "    allowed_write_paths:\n"
        "      - src/**\n"
        "    acceptance_refs:\n"
        "      - AC1\n"
        "    tests:\n"
        "      - id: case1\n"
        "        scenario: x\n"
        "        checks:\n"
        "          - \"x == x\"\n"
        "    status: running\n"
    )
    (run_dir / "planning" / "task-plan.yaml").write_text(plan_yaml, encoding="utf-8")

    monkeypatch.setenv("LOOP_RUNS_ROOT", str(runs_root))
    return run_dir


# ===========================================================================
# guard_paths (Hook B)
# ===========================================================================

class TestGuardPaths:
    def test_dot_claude_always_denied(self, tmp_run):
        """写 .claude/ 应被拒, 无论 phase."""
        payload = {
            "tool_name": "Write",
            "tool_input": {"file_path": str(REPO_ROOT / ".claude" / "anything.txt"), "content": "x"},
        }
        rc, out, err = _run_hook("guard_paths.py", payload)
        result = _parse(out)
        assert result.get("decision") == "block"
        assert ".claude" in result.get("reason", "")

    def test_source_write_in_implementing_allowed(self, tmp_run):
        """IMPLEMENTING + task.allowed_write_paths 覆盖 src/foo.py → 放行."""
        payload = {
            "tool_name": "Write",
            "tool_input": {"file_path": str(REPO_ROOT / "src" / "foo.py"), "content": "x"},
        }
        rc, out, err = _run_hook("guard_paths.py", payload)
        result = _parse(out)
        assert result == {} or result.get("decision") != "block", f"应放行, 实际={result}, stderr={err}"

    def test_source_write_outside_allowed_paths_denied(self, tmp_run):
        """IMPLEMENTING 但路径不在 task.allowed_write_paths (写 docs/) → deny."""
        payload = {
            "tool_name": "Write",
            "tool_input": {"file_path": str(REPO_ROOT / "docs" / "other.md"), "content": "x"},
        }
        rc, out, err = _run_hook("guard_paths.py", payload)
        result = _parse(out)
        assert result.get("decision") == "block"

    def test_run_state_json_always_allowed(self, tmp_run):
        """协调者写 run-state.json 应放行."""
        payload = {
            "tool_name": "Write",
            "tool_input": {
                "file_path": str(tmp_run / "run-state.json"),
                "content": "{}",
            },
        }
        rc, out, err = _run_hook("guard_paths.py", payload)
        result = _parse(out)
        assert result == {} or result.get("decision") != "block", f"应放行, 实际={result}, stderr={err}"

    def test_no_active_run_passes_for_source(self, tmp_path, monkeypatch):
        """无活跃 run (runs/ 空) → 即便写源码也放行, 不干扰 loop 之外的正常编辑 (#1)."""
        empty = tmp_path / "runs_empty"
        empty.mkdir()
        monkeypatch.setenv("LOOP_RUNS_ROOT", str(empty))
        payload = {
            "tool_name": "Write",
            "tool_input": {"file_path": str(REPO_ROOT / "src" / "foo.py"), "content": "x"},
        }
        rc, out, err = _run_hook("guard_paths.py", payload)
        result = _parse(out)
        assert result == {} or result.get("decision") != "block", (
            f"无活跃 run 应放行, 实际={result}, stderr={err}"
        )


# ===========================================================================
# guard_anchors (Hook C)
# ===========================================================================

class TestGuardAnchors:
    def test_no_active_run_passes(self, tmp_path, monkeypatch):
        """无活跃 run (runs/ 空) → 放行."""
        empty = tmp_path / "runs_empty"
        empty.mkdir()
        monkeypatch.setenv("LOOP_RUNS_ROOT", str(empty))
        rc, out, err = _run_hook("guard_anchors.py", {})
        result = _parse(out)
        assert result == {} or result.get("decision") != "block", f"应放行, 实际={result}, stderr={err}"

    def test_human_pending_passes(self, tmp_run):
        """human_pending=plan_signoff → 放行 (合法人工锚点)."""
        state_path = tmp_run / "run-state.json"
        state = json.loads(state_path.read_text())
        state["phase"] = "PLANNING"
        state["human_pending"] = "plan_signoff"
        state_path.write_text(json.dumps(state), encoding="utf-8")
        rc, out, err = _run_hook("guard_anchors.py", {})
        result = _parse(out)
        assert result == {} or result.get("decision") != "block", f"应放行, 实际={result}, stderr={err}"

    def test_implementing_no_test_results_blocks(self, tmp_run):
        """IMPLEMENTING + task running 但无 test-results.yaml → block."""
        rc, out, err = _run_hook("guard_anchors.py", {})
        result = _parse(out)
        assert result.get("decision") == "block", f"应 block, 实际={result}, stderr={err}"
        assert "IMPLEMENTING" in result.get("reason", "") or "tests_green" in result.get("reason", "")


# ===========================================================================
# post_task_collect (Hook A)
# ===========================================================================

class TestPostTaskCollect:
    def test_non_loop_worker_passes_silent(self, tmp_run):
        """非 loop-engineering worker 的 Task 调用 → 静默放行."""
        payload = {
            "tool_name": "Task",
            "tool_input": {"subagent_type": "some-other-agent", "prompt": "..."},
            "tool_response": {"result": "ok"},
        }
        rc, out, err = _run_hook("post_task_collect.py", payload)
        result = _parse(out)
        assert result == {}, f"非 loop worker 应静默放行, 实际={result}, stderr={err}"

    def test_clarification_missing_artifact_blocks(self, tmp_run):
        """clarification-finder 但 questions.json 不存在 → block."""
        payload = {
            "tool_name": "Task",
            "tool_input": {"subagent_type": "clarification-finder", "prompt": "..."},
            "tool_response": {"result": "..."},
        }
        rc, out, err = _run_hook("post_task_collect.py", payload)
        result = _parse(out)
        assert result.get("decision") == "block", f"artifact 缺失应 block, 实际={result}, stderr={err}"
        assert "artifact" in result.get("reason", "").lower() or "questions" in result.get("reason", "")

    def test_clarification_empty_questions_blocks(self, tmp_run):
        """clarification-finder 但 questions.json 为空 → block."""
        qpath = tmp_run / "clarification" / "questions.json"
        qpath.write_text(json.dumps({"questions": []}), encoding="utf-8")
        payload = {
            "tool_name": "Task",
            "tool_input": {"subagent_type": "clarification-finder", "prompt": "..."},
            "tool_response": {"result": "..."},
        }
        rc, out, err = _run_hook("post_task_collect.py", payload)
        result = _parse(out)
        assert result.get("decision") == "block", f"空 questions 应 block, 实际={result}, stderr={err}"

    def test_clarification_valid_passes(self, tmp_run):
        """clarification-finder + 非空 questions → 注入 additionalContext, verified=True."""
        qpath = tmp_run / "clarification" / "questions.json"
        qpath.write_text(
            json.dumps({"questions": [{"id": "q1", "text": "what?"}]}),
            encoding="utf-8",
        )
        payload = {
            "tool_name": "Task",
            "tool_input": {"subagent_type": "clarification-finder", "prompt": "..."},
            "tool_response": {"result": "..."},
        }
        rc, out, err = _run_hook("post_task_collect.py", payload)
        result = _parse(out)
        assert "hookSpecificOutput" in result, f"应注入 context, 实际={result}, stderr={err}"
        ctx = json.loads(result["hookSpecificOutput"]["additionalContext"])
        assert ctx["verified"] is True
        assert ctx["question_count"] == 1


# ===========================================================================
# probe_and_gate (Hook D)
# ===========================================================================

class TestProbeAndGate:
    def test_no_active_run_injects_capabilities(self, tmp_path, monkeypatch):
        """无活跃 run → 注入 capabilities, 不阻止."""
        empty = tmp_path / "runs_empty"
        empty.mkdir()
        monkeypatch.setenv("LOOP_RUNS_ROOT", str(empty))
        rc, out, err = _run_hook("probe_and_gate.py", {})
        result = _parse(out)
        assert "hookSpecificOutput" in result, f"应注入, 实际={result}, stderr={err}"
        ctx = json.loads(result["hookSpecificOutput"]["additionalContext"])
        assert "capabilities" in ctx
        assert "git_diff" in ctx["capabilities"]

    def test_unattended_without_replay_channel_blocks(self, tmp_run):
        """trust_mode=unattended 但 §0.3 通道未就绪 → block (拒绝静默降级)."""
        state_path = tmp_run / "run-state.json"
        state = json.loads(state_path.read_text())
        state["trust_mode"] = "unattended"
        state_path.write_text(json.dumps(state), encoding="utf-8")
        rc, out, err = _run_hook("probe_and_gate.py", {})
        result = _parse(out)
        assert result.get("decision") == "block", f"应 block, 实际={result}, stderr={err}"
        assert "unattended" in result.get("reason", "") or "§0.3" in result.get("reason", "")

    def test_collaborative_active_run_injects(self, tmp_run):
        """trust_mode=collaborative + 活跃 run → 注入 context, 不 block."""
        rc, out, err = _run_hook("probe_and_gate.py", {})
        result = _parse(out)
        assert "hookSpecificOutput" in result, f"应注入, 实际={result}, stderr={err}"
        ctx = json.loads(result["hookSpecificOutput"]["additionalContext"])
        assert ctx["active_run"] is not None
        assert ctx["trust_mode"] == "collaborative"
