"""Install Claude Code-facing loop-engineering assets into a project.

P0 约定: skill/agent/standards 等 Claude 资产位于仓库根的 core/ 目录
(由 T1+T2 从 loop_engineering/skills、loop_engineering/agents 迁入)。
editable install 模式下, 仓库根即 Path(__file__).resolve().parent.parent,
core/ 永远在该位置可读。正式 sdist/wheel 发布由后续 P 阶段处理。

settings.json 与 hooks 仍在 loop_engineering/ Python 包内, 由包数据机制携带。
Claude Code 从目标项目的 .claude/ 发现资产, 本模块把资产落到目标项目,
绝不从实现仓库自身的 .claude 读取。
"""
from __future__ import annotations

import json
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


def _merge_hooks(existing: dict, incoming: dict) -> dict:
    """把 incoming 的 hooks 块深合并进 existing, 保留 existing 其它配置。

    按 command 字符串去重: 同名 command 已注册则不重复追加 (重复安装幂等)。
    """
    merged = dict(existing)
    incoming_hooks = incoming.get("hooks", {}) or {}
    existing_hooks = existing.get("hooks")
    if not isinstance(existing_hooks, dict):
        merged["hooks"] = json.loads(json.dumps(incoming_hooks))
        return merged
    new_hooks = json.loads(json.dumps(existing_hooks))  # deep copy
    for event, groups in incoming_hooks.items():
        existing_groups = new_hooks.get(event)
        if not isinstance(existing_groups, list):
            new_hooks[event] = json.loads(json.dumps(groups))
            continue
        existing_cmds = {
            h.get("command")
            for g in existing_groups
            for h in (g or {}).get("hooks", []) or []
            if h.get("command")
        }
        for g in groups or []:
            new_entries = [
                h
                for h in (g or {}).get("hooks", []) or []
                if h.get("command") not in existing_cmds
            ]
            if not new_entries:
                continue
            new_group = dict(g)
            new_group["hooks"] = new_entries
            existing_groups.append(new_group)
        new_hooks[event] = existing_groups
    merged["hooks"] = new_hooks
    return merged


def _install_settings(
    src: Path, dst: Path, *, force: bool, result: ClaudeAssetInstallResult
) -> None:
    """安装 settings.json: 不存在则写入; 已存在则【深合并 hooks】, 保留用户其它配置 (修复 #3)。

    取代了原先的"整文件覆盖/跳过", 使本工具能安全装进已有 .claude/settings.json 的项目。
    用户 settings 不可解析时: force 覆盖, 否则保留并跳过 (绝不破坏用户文件)。
    """
    incoming = json.loads(src.read_text(encoding="utf-8"))
    dst.parent.mkdir(parents=True, exist_ok=True)
    if not dst.exists():
        dst.write_text(
            json.dumps(incoming, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        result.installed.append(dst)
        return
    try:
        existing = json.loads(dst.read_text(encoding="utf-8"))
        if not isinstance(existing, dict):
            raise ValueError("settings.json 顶层不是对象")
    except Exception:  # noqa: BLE001
        if force:
            dst.write_text(
                json.dumps(incoming, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
            result.installed.append(dst)
        else:
            result.skipped.append(dst)
        return
    merged = _merge_hooks(existing, incoming)
    if merged == existing:
        result.skipped.append(dst)
        return
    dst.write_text(
        json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    result.installed.append(dst)


def install_claude_assets(project_dir: str | Path, *, force: bool = False) -> ClaudeAssetInstallResult:
    """Copy bundled package assets into project_dir/.claude.

    Existing files are preserved by default. Pass force=True when syncing the
    package's canonical assets over an older installed copy.
    """
    project = Path(project_dir).resolve()
    package_root = Path(__file__).resolve().parent
    # P0: Claude 资产 (coordinator/subagents/standards/README) 位于仓库根 core/
    repo_root = package_root.parent
    core_dir = repo_root / "core"
    result = ClaudeAssetInstallResult(project_dir=project)
    claude_dir = project / ".claude"

    # settings.json + hooks 仍在 Python 包内
    _install_settings(package_root / "settings.json", claude_dir / "settings.json", force=force, result=result)
    _copy_tree_files(
        package_root / "hooks" / "loop_engineering",
        claude_dir / "hooks" / "loop_engineering",
        force=force,
        result=result,
    )

    # core/coordinator.md → .claude/skills/loop-engineering/SKILL.md (单文件重命名映射)
    _copy_file(
        core_dir / "coordinator.md",
        claude_dir / "skills" / "loop-engineering" / "SKILL.md",
        force=force,
        result=result,
    )
    # core/README.md → .claude/skills/loop-engineering/README.md
    if (core_dir / "README.md").is_file():
        _copy_file(
            core_dir / "README.md",
            claude_dir / "skills" / "loop-engineering" / "README.md",
            force=force,
            result=result,
        )
    # core/standards/ → .claude/skills/loop-engineering/standards/
    _copy_tree_files(
        core_dir / "standards",
        claude_dir / "skills" / "loop-engineering" / "standards",
        force=force,
        result=result,
    )
    # core/subagents/ → .claude/agents/
    _copy_tree_files(core_dir / "subagents", claude_dir / "agents", force=force, result=result)
    return result
