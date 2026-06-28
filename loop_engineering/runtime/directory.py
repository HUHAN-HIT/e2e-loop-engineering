"""Run 目录初始化与 run-state.json 原子读写 (design §6).

规范源: design §6 (Run 目录与 schema). coordinator 是 run-state.json 的单写者,
但本模块提供底层原子写工具. 任何调用方都应通过本模块读写 run-state.

run_id 格式: YYYYMMDD-NNN (按当日已有 run 数 +1, 避免冲突).
"""
from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from ..schema.run_state import RunState

__all__ = [
    "RUN_SUBDIRS",
    "init_run_dir",
    "write_run_state",
    "read_run_state",
    "init_task_dir",
    "next_run_id",
]

# design §6 子目录清单 (tasks 下每个 task 还会有自己的 <id>/ 子目录).
RUN_SUBDIRS: tuple[str, ...] = ("input", "clarification", "planning", "tasks", "wrap-up")


def init_run_dir(runs_root: Path, run_id: str, requirement_text: str) -> Path:
    """建 runs/<run_id>/ 与子目录, 写 input/requirement.md. 返回 run_dir.

    Args:
        runs_root: runs 根目录.
        run_id: 唯一 run id (调用方一般用 next_run_id 生成).
        requirement_text: 原始需求文本.

    Returns:
        run_dir (Path).

    Raises:
        FileExistsError: run_dir 已存在 (run_id 必须唯一).
    """
    runs_root = Path(runs_root)
    run_dir = runs_root / run_id
    if run_dir.exists():
        raise FileExistsError(f"run_dir 已存在: {run_dir} (run_id 必须唯一)")

    runs_root.mkdir(parents=True, exist_ok=True)
    run_dir.mkdir(parents=True)
    for sub in RUN_SUBDIRS:
        (run_dir / sub).mkdir()

    # 写 input/requirement.md
    (run_dir / "input" / "requirement.md").write_text(requirement_text, encoding="utf-8")
    return run_dir


def write_run_state(run_dir: Path, state: RunState) -> None:
    """原子写 run-state.json (写到 tmp 再 rename, 防半写状态).

    单写者约束由 coordinator 维护, 本函数不强制加锁.
    Windows 文件锁竞态: os.replace 偶发 PermissionError (杀软扫描 / 句柄未释放),
    重试 5 次 (每次退避 25ms), 仍失败才抛.
    """
    run_dir = Path(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    target = run_dir / "run-state.json"
    payload = state.model_dump_json(exclude_none=True, indent=2)
    # tempfile 同目录, 保证 rename 是原子的 (跨设备 rename 不是原子).
    fd, tmp_path = tempfile.mkstemp(
        prefix=".run-state-", suffix=".tmp", dir=str(run_dir)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(payload)
        _atomic_replace(tmp_path, target)
    except Exception:
        # 出错清掉 tmp, 不留垃圾
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _atomic_replace(src: Path, dst: Path, *, retries: int = 5, backoff_ms: int = 25) -> None:
    """Windows 友好的原子替换: 失败重试, 处理杀软 / 文件锁竞态."""
    import time
    last_err: Exception | None = None
    for i in range(retries):
        try:
            os.replace(src, dst)
            return
        except PermissionError as e:
            last_err = e
            if i < retries - 1:
                time.sleep(backoff_ms / 1000)
        except OSError as e:
            last_err = e
            if i < retries - 1:
                time.sleep(backoff_ms / 1000)
    assert last_err is not None
    raise last_err


def read_run_state(run_dir: Path) -> RunState:
    """读 run-state.json + parse. 文件不存在 → raise FileNotFoundError."""
    target = Path(run_dir) / "run-state.json"
    if not target.exists():
        raise FileNotFoundError(f"run-state.json 不存在: {target}")
    data = json.loads(target.read_text(encoding="utf-8"))
    return RunState.model_validate(data)


def init_task_dir(run_dir: Path, task_id: str) -> Path:
    """建 tasks/<id>/ 与 logs/ 子目录. 已存在不报错 (幂等)."""
    task_dir = Path(run_dir) / "tasks" / task_id
    (task_dir / "logs").mkdir(parents=True, exist_ok=True)
    return task_dir


def next_run_id(runs_root: Path) -> str:
    """生成下一个 run_id: YYYYMMDD-NNN.

    按当日已有 run 数 +1. 不预留 (调用方拿到 id 后应尽快 init_run_dir 占位).
    """
    runs_root = Path(runs_root)
    today = datetime.now(timezone.utc).strftime("%Y%m%d")
    prefix = today + "-"
    n = 1
    if runs_root.exists():
        existing = [
            p.name for p in runs_root.iterdir() if p.is_dir() and p.name.startswith(prefix)
        ]
        # 解析已有 NNN 序号, 取最大 +1
        seqs: list[int] = []
        for name in existing:
            tail = name[len(prefix):]
            try:
                seqs.append(int(tail))
            except ValueError:
                continue
        if seqs:
            n = max(seqs) + 1
    return f"{prefix}{n:03d}"
