"""actual_writes 模块测试 (design §3.4).

覆盖:
- take_fs_snapshot: 排除噪音 / 相对路径 / 新增 / 修改 / 不变.
- collect_actual_writes: 三层优先级 (git / fs / self_report).
- detect_out_of_bounds: 无越界 / 越界 / 空 actual / 跨 task 共享 / 注入 path_overlap_fn.
"""
from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from loop_engineering.scheduling.actual_writes import (
    ActualWritesCollection,
    OOBDetection,
    collect_actual_writes,
    collect_via_fs_snapshot,
    collect_via_git_diff,
    detect_out_of_bounds,
    take_fs_snapshot,
)
from loop_engineering.schema.run_state import RunCapabilities
from loop_engineering.schema.task_plan import Task, TaskStatus


def _make_task(
    task_id: str = "T1",
    allowed: list[str] | None = None,
) -> Task:
    return Task(
        id=task_id,
        title=f"task {task_id}",
        allowed_write_paths=allowed if allowed is not None else ["src/**"],
        acceptance_refs=["AC1"],
        status=TaskStatus.complete,
    )


# ---------------------------------------------------------------------------
# take_fs_snapshot
# ---------------------------------------------------------------------------


def test_take_fs_snapshot_excludes_noise(tmp_path: Path) -> None:
    """__pycache__ / .git / node_modules 不在快照."""
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "a.py").write_text("x = 1", encoding="utf-8")
    (tmp_path / "__pycache__").mkdir()
    (tmp_path / "__pycache__" / "a.pyc").write_text("noise", encoding="utf-8")
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "HEAD").write_text("noise", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "lib.js").write_text("noise", encoding="utf-8")

    snap = take_fs_snapshot(tmp_path)
    paths = set(snap.keys())
    assert "src/a.py" in paths
    assert all("__pycache__" not in p for p in paths)
    assert all(".git" not in p for p in paths)
    assert all("node_modules" not in p for p in paths)
    assert all(not p.endswith(".pyc") for p in paths)


def test_take_fs_snapshot_returns_relative_paths(tmp_path: Path) -> None:
    """路径相对 workdir, POSIX 风格."""
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "a.py").write_text("x", encoding="utf-8")
    snap = take_fs_snapshot(tmp_path)
    assert "src/a.py" in snap
    # 不含 workdir 绝对前缀.
    assert all(not p.startswith(str(tmp_path)) for p in snap)


def test_fs_snapshot_detects_new_file(tmp_path: Path) -> None:
    """before 无 after 有 → 检测到."""
    before = take_fs_snapshot(tmp_path)
    (tmp_path / "new.py").write_text("x = 1", encoding="utf-8")
    after = take_fs_snapshot(tmp_path)
    changed = collect_via_fs_snapshot(before, after)
    assert "new.py" in changed


def test_fs_snapshot_detects_modified_file(tmp_path: Path) -> None:
    """mtime 变化 → 检测到."""
    f = tmp_path / "a.py"
    f.write_text("x = 1", encoding="utf-8")
    before = take_fs_snapshot(tmp_path)
    # 强制 mtime 改变.
    time.sleep(0.01)
    if os.name == "nt":
        time.sleep(0.01)
    f.write_text("x = 2", encoding="utf-8")
    after = take_fs_snapshot(tmp_path)
    changed = collect_via_fs_snapshot(before, after)
    assert "a.py" in changed


def test_fs_snapshot_ignores_unchanged(tmp_path: Path) -> None:
    """未变 → 不在 changed."""
    (tmp_path / "a.py").write_text("x = 1", encoding="utf-8")
    before = take_fs_snapshot(tmp_path)
    after = take_fs_snapshot(tmp_path)
    changed = collect_via_fs_snapshot(before, after)
    assert changed == []


def test_fs_snapshot_detects_deleted_file(tmp_path: Path) -> None:
    """删除也算写过 (before 有 after 无)."""
    f = tmp_path / "a.py"
    f.write_text("x", encoding="utf-8")
    before = take_fs_snapshot(tmp_path)
    f.unlink()
    after = take_fs_snapshot(tmp_path)
    changed = collect_via_fs_snapshot(before, after)
    assert "a.py" in changed


# ---------------------------------------------------------------------------
# collect_actual_writes 优先级
# ---------------------------------------------------------------------------


def test_collect_prefers_git_when_available(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """git_diff=True + base_ref → source=git_diff, authoritative."""
    monkeypatch.setattr(
        "loop_engineering.scheduling.actual_writes.collect_via_git_diff",
        lambda workdir, base_ref: ["git.py"],
    )
    caps = RunCapabilities(git_diff=True, fs_snapshot=True)
    result = collect_actual_writes(
        tmp_path,
        "T1",
        caps,
        base_ref="HEAD",
        before_snapshot={},
        after_snapshot={},
        worker_self_report=["x.py"],
    )
    assert result.source == "git_diff"
    assert result.is_authoritative is True
    assert result.writes == ["git.py"]


def test_collect_falls_back_to_fs(tmp_path: Path) -> None:
    """git_diff=False, fs_snapshot=True + before/after → source=fs_snapshot."""
    caps = RunCapabilities(git_diff=False, fs_snapshot=True)
    result = collect_actual_writes(
        tmp_path,
        "T1",
        caps,
        base_ref=None,
        before_snapshot={"a.py": 1.0},
        after_snapshot={"a.py": 2.0},
        worker_self_report=["x.py"],
    )
    assert result.source == "fs_snapshot"
    assert result.is_authoritative is True
    assert result.writes == ["a.py"]


def test_collect_falls_back_to_worker_self_report(tmp_path: Path) -> None:
    """都没 → source=worker_self_report, 非 authoritative."""
    caps = RunCapabilities(git_diff=False, fs_snapshot=False)
    result = collect_actual_writes(
        tmp_path,
        "T1",
        caps,
        base_ref=None,
        before_snapshot=None,
        after_snapshot=None,
        worker_self_report=["x.py", "y.py"],
    )
    assert result.source == "worker_self_report"
    assert result.is_authoritative is False
    assert result.writes == ["x.py", "y.py"]


def test_collect_handles_missing_inputs_gracefully(tmp_path: Path) -> None:
    """git_diff=True 但 base_ref=None → 降级 fs 或 self_report."""
    caps = RunCapabilities(git_diff=True, fs_snapshot=True)
    result = collect_actual_writes(
        tmp_path,
        "T1",
        caps,
        base_ref=None,  # git 不可用 (没 base_ref)
        before_snapshot={"a.py": 1.0},
        after_snapshot={"a.py": 2.0},
        worker_self_report=None,
    )
    # 降级到 fs (authoritative).
    assert result.source == "fs_snapshot"
    assert result.is_authoritative is True


def test_collect_self_report_default_empty(tmp_path: Path) -> None:
    """worker_self_report 未提供 → 空 list."""
    caps = RunCapabilities(git_diff=False, fs_snapshot=False)
    result = collect_actual_writes(tmp_path, "T1", caps)
    assert result.source == "worker_self_report"
    assert result.writes == []


# ---------------------------------------------------------------------------
# detect_out_of_bounds
# ---------------------------------------------------------------------------


def _overlap_stub_in_declared(declared_globs: list[str]) -> "object":
    """构造 stub: path 在 declared 内时 overlap 返回 True, 否则 False.

    用于多数越界测试, 避开 S3 真实实现.
    """

    def fn(a: list[str], b: list[str]) -> bool:
        # 简化: a 中任一路径前缀匹配 b 中任一前缀即视为"在 declared 内".
        for x in a:
            for y in b:
                prefix = y.replace("/**", "").rstrip("/")
                if prefix == "" or x == prefix or x.startswith(prefix + "/"):
                    return True
        return False

    return fn


def test_detect_oob_no_oob() -> None:
    """actual ⊆ allowed → is_oob=False."""
    task = _make_task("T1", allowed=["src/**"])
    collection = ActualWritesCollection(
        task_id="T1",
        source="fs_snapshot",
        writes=["src/a.py", "src/b.py"],
        is_authoritative=True,
    )
    result = detect_out_of_bounds(
        task,
        collection,
        path_overlap_fn=_overlap_stub_in_declared(task.allowed_write_paths),
    )
    assert result.is_oob is False
    assert result.out_of_bounds == []


def test_detect_oob_finds_extra_path() -> None:
    """actual 含 allowed 外的路径 → is_oob=True."""
    task = _make_task("T1", allowed=["src/**"])
    collection = ActualWritesCollection(
        task_id="T1",
        source="fs_snapshot",
        writes=["src/a.py", "tests/x.py"],
        is_authoritative=True,
    )
    result = detect_out_of_bounds(
        task,
        collection,
        path_overlap_fn=_overlap_stub_in_declared(task.allowed_write_paths),
    )
    assert result.is_oob is True
    assert "tests/x.py" in result.out_of_bounds


def test_detect_oob_empty_actual_no_crash() -> None:
    """actual=[] → is_oob=False, 不抛."""
    task = _make_task("T1", allowed=["src/**"])
    collection = ActualWritesCollection(
        task_id="T1",
        source="fs_snapshot",
        writes=[],
        is_authoritative=True,
    )
    result = detect_out_of_bounds(
        task,
        collection,
        path_overlap_fn=_overlap_stub_in_declared(task.allowed_write_paths),
    )
    assert result.is_oob is False
    assert result.out_of_bounds == []


def test_detect_oob_cross_task_shared_path() -> None:
    """actual 含已被其他 task 写的路径 → 越界 (§3.4 归最早写入者)."""
    task = _make_task("T1", allowed=["src/**"])
    collection = ActualWritesCollection(
        task_id="T1",
        source="fs_snapshot",
        writes=["src/shared.py"],
        is_authoritative=True,
    )
    # src/shared.py 已被 T0 写过.
    earlier = {"src/shared.py": ["T0"]}
    result = detect_out_of_bounds(
        task,
        collection,
        path_overlap_fn=_overlap_stub_in_declared(task.allowed_write_paths),
        earlier_task_writes=earlier,
    )
    assert result.is_oob is True
    assert "src/shared.py" in result.out_of_bounds


def test_detect_oob_uses_injected_path_overlap_fn() -> None:
    """验证 path_overlap_fn 被调用, 不直接 import path_overlap."""
    task = _make_task("T1", allowed=["src/**"])
    collection = ActualWritesCollection(
        task_id="T1",
        source="fs_snapshot",
        writes=["src/a.py"],
        is_authoritative=True,
    )
    call_count = {"n": 0}

    def spy_fn(a: list[str], b: list[str]) -> bool:
        call_count["n"] += 1
        return True  # 全部视为在 declared 内

    result = detect_out_of_bounds(
        task,
        collection,
        path_overlap_fn=spy_fn,
    )
    assert call_count["n"] >= 1
    assert result.is_oob is False


def test_detect_oob_returns_oob_detection_instance() -> None:
    """返回类型为 OOBDetection."""
    task = _make_task("T1", allowed=["src/**"])
    collection = ActualWritesCollection(
        task_id="T1", source="fs_snapshot", writes=[], is_authoritative=True
    )
    result = detect_out_of_bounds(
        task,
        collection,
        path_overlap_fn=lambda a, b: True,
    )
    assert isinstance(result, OOBDetection)
    assert result.task_id == "T1"


def test_detect_oob_empty_declared_treats_all_as_oob() -> None:
    """task 没有 allowed_write_paths → 任何 actual 都算越界 (除空 actual)."""
    task = _make_task("T1", allowed=[])
    collection = ActualWritesCollection(
        task_id="T1",
        source="fs_snapshot",
        writes=["x.py"],
        is_authoritative=True,
    )
    result = detect_out_of_bounds(
        task,
        collection,
        path_overlap_fn=lambda a, b: False if not b else True,
    )
    assert result.is_oob is True

def test_collect_falls_back_when_git_collection_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "loop_engineering.scheduling.actual_writes.collect_via_git_diff",
        lambda workdir, base_ref: None,
    )
    caps = RunCapabilities(git_diff=True, fs_snapshot=True)
    result = collect_actual_writes(
        tmp_path,
        "T1",
        caps,
        base_ref="HEAD",
        before_snapshot={"a.py": 1.0},
        after_snapshot={"a.py": 2.0},
        worker_self_report=["worker.py"],
    )
    assert result.source == "fs_snapshot"
    assert result.is_authoritative is True
    assert result.writes == ["a.py"]
