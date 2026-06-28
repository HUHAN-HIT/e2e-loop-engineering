"""actual_writes 反馈环 (design §3.4).

规范源: design §3.4 —— worker 交回后, coordinator 从 git diff 或 fs snapshot **独立采集**
actual_writes (不经 worker 自报), 用于越界检测与调度并发度校正.

三层采集优先级:
1. capabilities.git_diff=True 且 base_ref 提供 → git diff (authoritative).
2. capabilities.fs_snapshot=True 且 before_snapshot 提供 → fs 对比 (authoritative).
3. 否则回退 worker_self_report (非 authoritative, 软约束).

越界检测两层:
1. actual_writes 中有路径不在 task.allowed_write_paths 范围内 → 越界.
2. actual_writes 中有路径已被更早 task 写过 (跨 task 共享路径归最早写入者) → 越界.

path 重叠判定通过注入的 path_overlap_fn (= S3.path_globs_overlap) 完成, 本模块不硬依赖 S3,
便于在 S3 之前测试与解耦.

诚实声明 (§3.4): 越界按"写过"判不按"最终内容"判 —— worker 先写再删的路径仍计入.
git diff 路径下用 `git diff --name-only` + `git status --porcelain` 抓全量 (单 diff 抓不到
untracked). fs snapshot 路径下用 mtime_ns 对比, 同样能抓到"写过又删" (因为快照里 before 有
after 没有的路径算变更) —— 但"写了又删到 mtime 都恢复"的极端情况 fs 抓不到, 那种场景只能靠 git.
"""
from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from ..schema.run_state import RunCapabilities
from ..schema.task_plan import Task

__all__ = [
    "ActualWritesCollection",
    "OOBDetection",
    "collect_via_git_diff",
    "collect_via_fs_snapshot",
    "take_fs_snapshot",
    "collect_actual_writes",
    "detect_out_of_bounds",
]


# fs snapshot 排除的目录 / 后缀 (避免噪音污染对比基线).
_FS_EXCLUDE_DIRS: frozenset[str] = frozenset(
    {".git", "__pycache__", "node_modules", ".pytest_cache", ".mypy_cache", ".ruff_cache"}
)
_FS_EXCLUDE_SUFFIXES: tuple[str, ...] = (".pyc", ".pyo")


@dataclass(frozen=True)
class ActualWritesCollection:
    """一次 task 完成后的实际写入采集结果.

    is_authoritative=True 表示由 coordinator 侧独立采集 (git / fs), 数据不经 worker.
    is_authoritative=False 表示回退 worker 自报, 第 2 层防线退化为软约束 (§3.4).
    """

    task_id: str
    source: str  # "git_diff" | "fs_snapshot" | "worker_self_report"
    writes: list[str] = field(default_factory=list)
    is_authoritative: bool = False


@dataclass(frozen=True)
class OOBDetection:
    """越界写检测结果 (out-of-bounds)."""

    task_id: str
    declared_paths: list[str]
    actual_writes: list[str]
    out_of_bounds: list[str]
    is_oob: bool


# ---------------------------------------------------------------------------
# 三层采集器
# ---------------------------------------------------------------------------


def collect_via_git_diff(workdir: Path, base_ref: str) -> list[str] | None:
    """git diff --name-only <base_ref> + git status --porcelain 抓全量变更文件.

    §3.4 "越界按写过判": 单 `git diff` 抓不到 untracked, 故双管齐下:
    - `git diff --name-only --diff-filter=ADMR <base_ref>`: added/deleted/modified/renamed
      (跨 base_ref → HEAD/工作树).
    - `git status --porcelain`: 抓 untracked / 已 stage 但未 commit / 工作树修改.
    合并去重, 返回相对 workdir 的 POSIX 路径列表.

    失败 (非 git repo / bad ref / subprocess 异常) 返回 None; 调用方必须降级到 fs snapshot
    或 worker_self_report, 不能把采集失败伪装成 authoritative empty diff.
    """
    writes: set[str] = set()
    try:
        diff_result = subprocess.run(
            ["git", "-C", str(workdir), "diff", "--name-only", "--diff-filter=ADMR", base_ref],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if diff_result.returncode != 0:
            return None
        for line in (diff_result.stdout or "").splitlines():
            line = line.strip()
            if line:
                writes.add(line.replace("\", "/"))
    except (OSError, subprocess.SubprocessError):
        return None

    try:
        status_result = subprocess.run(
            ["git", "-C", str(workdir), "status", "--porcelain"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if status_result.returncode != 0:
            return None
        for line in (status_result.stdout or "").splitlines():
            if not line:
                continue
            # porcelain 格式: "XY path", XY 是两字符状态, 之后空格 + path.
            path = line[3:].strip().strip('"')
            if path:
                writes.add(path.replace("\", "/"))
    except (OSError, subprocess.SubprocessError):
        return None

    return sorted(writes)


def _should_exclude_path(rel_path: str) -> bool:
    """fs snapshot 是否排除该相对路径 (按目录段 / 后缀)."""
    if rel_path.endswith(_FS_EXCLUDE_SUFFIXES):
        return True
    parts = rel_path.split("/")
    for seg in parts:
        if seg in _FS_EXCLUDE_DIRS:
            return True
    return False


def take_fs_snapshot(workdir: Path) -> dict[str, float]:
    """遍历 workdir, 返回 {relative_posix_path: mtime_ns}.

    排除 .git / __pycache__ / node_modules / .pytest_cache / *.pyc 等噪音目录与后缀,
    避免它们污染 diff 基线. 失败的 stat 跳过 (不抛).
    """
    snapshot: dict[str, float] = {}
    root = Path(workdir)
    try:
        for p in root.rglob("*"):
            if not p.is_file():
                continue
            try:
                rel = p.relative_to(root).as_posix()
            except ValueError:
                continue
            if _should_exclude_path(rel):
                continue
            try:
                snapshot[rel] = p.stat().st_mtime_ns
            except OSError:
                continue
    except (OSError, PermissionError):
        return snapshot
    return snapshot


def collect_via_fs_snapshot(
    before_snapshot: dict[str, float],
    after_snapshot: dict[str, float],
) -> list[str]:
    """对比两个 {path: mtime_ns} 快照, 返回 mtime 变化或新增的路径.

    删除的路径 (before 有 after 无) 也算"被写过" (worker 删过它), 一并计入 §3.4 "写过"判.
    """
    changed: list[str] = []
    all_paths = set(before_snapshot) | set(after_snapshot)
    for path in all_paths:
        b = before_snapshot.get(path)
        a = after_snapshot.get(path)
        if b != a:
            changed.append(path)
    return sorted(changed)


def collect_actual_writes(
    workdir: Path,
    task_id: str,
    capabilities: RunCapabilities,
    *,
    base_ref: str | None = None,
    before_snapshot: dict[str, float] | None = None,
    after_snapshot: dict[str, float] | None = None,
    worker_self_report: list[str] | None = None,
) -> ActualWritesCollection:
    """按 §3.4 三层优先级采集 actual_writes.

    1. capabilities.git_diff=True 且 base_ref 提供 → git diff (authoritative).
    2. capabilities.fs_snapshot=True 且 before_snapshot 与 after_snapshot 都提供 → fs 对比
       (authoritative).
    3. 否则回退 worker_self_report (非 authoritative).

    缺输入时优雅降级: 例如 git_diff=True 但 base_ref=None → 走 fs 或 self_report.
    """
    if capabilities.git_diff and base_ref:
        writes = collect_via_git_diff(workdir, base_ref)
        if writes is not None:
            return ActualWritesCollection(
                task_id=task_id,
                source="git_diff",
                writes=writes,
                is_authoritative=True,
            )

    if capabilities.fs_snapshot and before_snapshot is not None and after_snapshot is not None:
        writes = collect_via_fs_snapshot(before_snapshot, after_snapshot)
        return ActualWritesCollection(
            task_id=task_id,
            source="fs_snapshot",
            writes=writes,
            is_authoritative=True,
        )

    return ActualWritesCollection(
        task_id=task_id,
        source="worker_self_report",
        writes=list(worker_self_report or []),
        is_authoritative=False,
    )


# ---------------------------------------------------------------------------
# 越界检测
# ---------------------------------------------------------------------------


def detect_out_of_bounds(
    task: Task,
    collection: ActualWritesCollection,
    *,
    path_overlap_fn: Callable[[list[str], list[str]], bool],
    earlier_task_writes: dict[str, list[str]] | None = None,
) -> OOBDetection:
    """越界判定 (§3.4 两层).

    1. actual_writes 中有路径不在 task.allowed_write_paths 范围内 → 越界.
       用注入的 path_overlap_fn 判单条 path 是否落在 allowed globs 内: 反向用
       overlap(path_globs=[path], allowed=task.allowed_write_paths), False 即越界.
    2. actual_writes 中有路径已被更早 task 写过 → 越界 (跨 task 共享路径归最早写入者).

    path_overlap_fn 通过参数注入 (典型值 = S3.path_globs_overlap), 避免硬依赖 S3, 便于测试.
    actual_writes 为空 → 不越界 (is_oob=False), 不抛.
    """
    declared = list(task.allowed_write_paths)
    actual = list(collection.writes)
    oob: list[str] = []

    for path in actual:
        # 层 1: path 不在 declared 范围内 → 越界.
        # path_overlap_fn 返回 False 表示无重叠, 即 path 不属于任何 declared glob.
        in_declared = path_overlap_fn([path], declared) if declared else False
        if not in_declared:
            oob.append(path)
            continue
        # 层 2: path 已被更早 task 写过 → 越界 (归最早写入者).
        if earlier_task_writes and path in earlier_task_writes:
            oob.append(path)

    return OOBDetection(
        task_id=task.id,
        declared_paths=declared,
        actual_writes=actual,
        out_of_bounds=oob,
        is_oob=len(oob) > 0,
    )
