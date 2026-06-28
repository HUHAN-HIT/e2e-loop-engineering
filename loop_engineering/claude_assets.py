"""Install Claude Code-facing loop-engineering assets into a project.

The Python package is the executable SSOT, but Claude Code discovers skills,
agents, and hooks from the target project's .claude directory. This module keeps
those two planes synchronized without requiring callers to hand-copy files.
"""
from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class ClaudeAssetInstallResult:
    """Summary of a Claude asset installation."""

    project_dir: Path
    installed: list[Path] = field(default_factory=list)
    skipped: list[Path] = field(default_factory=list)


def _copy_file(src: Path, dst: Path, *, force: bool, result: ClaudeAssetInstallResult) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists() and not force:
        result.skipped.append(dst)
        return
    shutil.copy2(src, dst)
    result.installed.append(dst)


def _copy_tree_files(src_dir: Path, dst_dir: Path, *, force: bool, result: ClaudeAssetInstallResult) -> None:
    for src in sorted(p for p in src_dir.rglob("*") if p.is_file()):
        if "__pycache__" in src.parts or src.suffix == ".pyc":
            continue
        rel = src.relative_to(src_dir)
        _copy_file(src, dst_dir / rel, force=force, result=result)


def install_claude_assets(project_dir: str | Path, *, force: bool = False) -> ClaudeAssetInstallResult:
    """Copy bundled skill, agents, hooks, and settings into project_dir/.claude.

    Existing files are preserved by default. Pass force=True when syncing the
    package's canonical assets over an older installed copy.
    """
    project = Path(project_dir).resolve()
    package_root = Path(__file__).resolve().parent
    result = ClaudeAssetInstallResult(project_dir=project)
    claude_dir = project / ".claude"

    _copy_file(package_root / "settings.json", claude_dir / "settings.json", force=force, result=result)
    _copy_tree_files(
        package_root / "skills" / "loop-engineering",
        claude_dir / "skills" / "loop-engineering",
        force=force,
        result=result,
    )
    _copy_tree_files(package_root / "agents", claude_dir / "agents", force=force, result=result)
    _copy_tree_files(
        package_root / "hooks" / "loop_engineering",
        claude_dir / "hooks" / "loop_engineering",
        force=force,
        result=result,
    )
    return result
