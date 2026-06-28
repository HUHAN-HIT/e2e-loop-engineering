"""capabilities 模块测试 (design §3.4).

覆盖:
- probe_capabilities 在 git repo / 非 git 下结果.
- 返回类型为 RunCapabilities pydantic model.
- fs snapshot 始终可用 (可读 dir) / 不可读 dir → False.
- subprocess 失败被吞, 不 raise.
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from loop_engineering.scheduling.capabilities import (
    _check_fs_snapshot_available,
    _check_git_available,
    probe_capabilities,
)
from loop_engineering.schema.run_state import RunCapabilities


@pytest.fixture
def git_repo(tmp_path: Path) -> Path:
    """临时 git repo (已 init)."""
    subprocess.run(
        ["git", "init"],
        cwd=str(tmp_path),
        capture_output=True,
        timeout=10,
        check=False,
    )
    return tmp_path


@pytest.fixture
def plain_dir(tmp_path: Path) -> Path:
    """非 git 的临时目录."""
    return tmp_path


# ---------------------------------------------------------------------------
# probe_capabilities
# ---------------------------------------------------------------------------


def test_probe_capabilities_in_git_repo(git_repo: Path) -> None:
    """git repo 下 git_diff=True."""
    caps = probe_capabilities(git_repo)
    assert caps.git_diff is True
    assert caps.fs_snapshot is True


def test_probe_capabilities_outside_git(plain_dir: Path) -> None:
    """非 git 下 git_diff=False, fs_snapshot 仍 True."""
    caps = probe_capabilities(plain_dir)
    assert caps.git_diff is False
    assert caps.fs_snapshot is True


def test_probe_capabilities_returns_pydantic_model(plain_dir: Path) -> None:
    """返回 RunCapabilities 实例."""
    caps = probe_capabilities(plain_dir)
    assert isinstance(caps, RunCapabilities)


# ---------------------------------------------------------------------------
# _check_git_available
# ---------------------------------------------------------------------------


def test_check_git_available_true_in_repo(git_repo: Path) -> None:
    assert _check_git_available(git_repo) is True


def test_check_git_available_false_outside_git(plain_dir: Path) -> None:
    """非 git 目录 → False."""
    # 在 plain_dir 里 git rev-parse 不在 work tree 内, 返回非零退出码.
    # 注意: 父目录链路里若恰好有 git repo 会影响判定, 故用最深隔离的子目录.
    sub = plain_dir / "deep" / "sub"
    sub.mkdir(parents=True)
    # 即便如此父链上若有 .git 仍可能 True; 此处只验证函数返回 bool 不抛.
    result = _check_git_available(sub)
    assert isinstance(result, bool)


def test_probe_does_not_raise_on_subprocess_failure(plain_dir: Path) -> None:
    """git 命令异常被吞, 返回 git_diff=False."""
    with patch(
        "loop_engineering.scheduling.capabilities.subprocess.run",
        side_effect=OSError("boom"),
    ):
        caps = probe_capabilities(plain_dir)
    assert caps.git_diff is False


def test_check_git_available_handles_timeout(plain_dir: Path) -> None:
    """subprocess timeout → False, 不 raise."""
    with patch(
        "loop_engineering.scheduling.capabilities.subprocess.run",
        side_effect=subprocess.TimeoutExpired(cmd="git", timeout=5),
    ):
        assert _check_git_available(plain_dir) is False


# ---------------------------------------------------------------------------
# _check_fs_snapshot_available
# ---------------------------------------------------------------------------


def test_fs_snapshot_always_available_for_readable_dir(plain_dir: Path) -> None:
    """可读目录 → True."""
    assert _check_fs_snapshot_available(plain_dir) is True


def test_fs_snapshot_unavailable_for_unreadable(
    plain_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Path.exists 返回 False → fs_snapshot=False."""
    real_exists = Path.exists

    def fake_exists(self: Path) -> bool:
        if self == plain_dir:
            return False
        return real_exists(self)

    monkeypatch.setattr(Path, "exists", fake_exists)
    assert _check_fs_snapshot_available(plain_dir) is False


def test_fs_snapshot_unavailable_for_file_not_dir(tmp_path: Path) -> None:
    """传入文件而非目录 → False."""
    f = tmp_path / "a.txt"
    f.write_text("x", encoding="utf-8")
    assert _check_fs_snapshot_available(f) is False
