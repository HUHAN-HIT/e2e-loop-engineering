"""宿主能力探测 (design §3.4).

规范源: design §3.4 —— run 启动 (CREATED) 时 coordinator 一次性探测 git/fs diff 能力,
写入 run-state.capabilities, 此后整个 run 的 actual_writes 采集路径据此固定.

不预设 True, 以探测结果为准 (§3.4 原文). 任何探测异常都被吞掉返回 False,
避免脏环境导致 run 启动失败.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

from ..schema.run_state import RunCapabilities

__all__ = ["probe_capabilities"]


def _check_git_available(workdir: Path) -> bool:
    """subprocess 跑 `git -C <workdir> rev-parse --is-inside-work-tree`.

    退出码 0 且 stdout 含 'true' → True. 任何异常 / 非零退出 / 超时 → False.
    不 raise, 不污染 stderr.
    """
    try:
        result = subprocess.run(
            ["git", "-C", str(workdir), "rev-parse", "--is-inside-work-tree"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    if result.returncode != 0:
        return False
    return "true" in (result.stdout or "").strip()


def _check_fs_snapshot_available(workdir: Path) -> bool:
    """workdir 存在且可读 → True.

    不实际做快照 (快照逻辑在 actual_writes.take_fs_snapshot). 此处只验证基本可访问性.
    """
    try:
        return Path(workdir).exists() and Path(workdir).is_dir()
    except OSError:
        return False


def probe_capabilities(workdir: Path) -> RunCapabilities:
    """CREATED 时一次性探测宿主能力, 返回 RunCapabilities(git_diff=..., fs_snapshot=...).

    顺序与优先级 (§3.4): git_diff 优先; fs_snapshot 始终尝试 (pathlib 总能用, 但 workdir
    不可读时为 False). 探测结果固化为 RunCapabilities, 由 coordinator 写入 run-state.
    """
    return RunCapabilities(
        git_diff=_check_git_available(workdir),
        fs_snapshot=_check_fs_snapshot_available(workdir),
    )
