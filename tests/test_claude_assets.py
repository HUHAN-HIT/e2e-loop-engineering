"""Claude Code asset installation tests."""
from __future__ import annotations

import json
import re
from pathlib import Path

from loop_engineering.claude_assets import install_claude_assets
from loop_engineering.cli import build_parser

CRAFT_STANDARDS = [
    "glossary",
    "clarification-standard",
    "plan-standard",
    "test-design-standard",
    "implementation-standard",
    "review-standard",
]


def test_install_claude_assets_copies_skill_agents_hooks_and_settings(tmp_path: Path) -> None:
    result = install_claude_assets(tmp_path)

    assert (tmp_path / ".claude" / "settings.json").is_file()
    assert (tmp_path / ".claude" / "skills" / "loop-engineering" / "SKILL.md").is_file()
    assert (tmp_path / ".claude" / "agents" / "implementation-worker.md").is_file()
    assert (tmp_path / ".claude" / "hooks" / "loop_engineering" / "post_task_collect.py").is_file()
    assert result.installed
    assert not result.skipped


def test_install_claude_assets_preserves_existing_files_without_force(tmp_path: Path) -> None:
    install_claude_assets(tmp_path)
    skill = tmp_path / ".claude" / "skills" / "loop-engineering" / "SKILL.md"
    skill.write_text("custom", encoding="utf-8")

    result = install_claude_assets(tmp_path)

    assert skill.read_text(encoding="utf-8") == "custom"
    assert skill in result.skipped


def test_install_claude_parser_requires_explicit_project_dir() -> None:
    parser = build_parser()

    try:
        parser.parse_args(["install-claude"])
    except SystemExit as exc:
        assert exc.code == 2
    else:
        raise AssertionError("install-claude must require --project-dir")


def test_install_claude_parser_accepts_explicit_project_dir(tmp_path: Path) -> None:
    parser = build_parser()

    args = parser.parse_args(["install-claude", "--project-dir", str(tmp_path)])

    assert args.project_dir == str(tmp_path)


def test_install_claude_assets_includes_craft_standards(tmp_path: Path) -> None:
    install_claude_assets(tmp_path)

    standards_dir = tmp_path / ".claude" / "skills" / "loop-engineering" / "standards"
    for name in CRAFT_STANDARDS:
        assert (standards_dir / f"{name}.md").is_file(), f"missing standard: {name}.md"


def _all_hook_commands(settings: dict) -> list[str]:
    cmds: list[str] = []
    for groups in (settings.get("hooks") or {}).values():
        for g in groups or []:
            for h in (g or {}).get("hooks", []) or []:
                c = h.get("command")
                if c:
                    cmds.append(c)
    return cmds


def test_install_merges_into_existing_settings(tmp_path: Path) -> None:
    """已有 settings.json 时, 安装应深合并 hooks 并保留用户其它配置 (修复 #3)。"""
    claude = tmp_path / ".claude"
    claude.mkdir(parents=True)
    user_settings = {
        "permissions": {"allow": ["Bash(ls:*)"]},
        "hooks": {
            "PreToolUse": [
                {"matcher": "Read", "hooks": [{"type": "command", "command": "echo user-hook"}]}
            ]
        },
    }
    settings_path = claude / "settings.json"
    settings_path.write_text(json.dumps(user_settings), encoding="utf-8")

    install_claude_assets(tmp_path, force=False)

    merged = json.loads(settings_path.read_text(encoding="utf-8"))
    assert merged["permissions"]["allow"] == ["Bash(ls:*)"], "用户其它配置必须保留"
    cmds = _all_hook_commands(merged)
    assert "echo user-hook" in cmds, "用户原有 hook 必须保留"
    for needle in ["probe_and_gate.py", "guard_paths.py", "post_task_collect.py", "guard_anchors.py"]:
        assert any(needle in c for c in cmds), f"loop hook {needle} 未注入"


def test_install_settings_merge_is_idempotent(tmp_path: Path) -> None:
    """重复安装不重复注册同一 hook (按 command 去重)。"""
    install_claude_assets(tmp_path)
    install_claude_assets(tmp_path, force=True)

    settings_path = tmp_path / ".claude" / "settings.json"
    cmds = _all_hook_commands(json.loads(settings_path.read_text(encoding="utf-8")))
    for needle in ["probe_and_gate.py", "guard_paths.py", "post_task_collect.py", "guard_anchors.py"]:
        assert sum(1 for c in cmds if needle in c) == 1, f"{needle} 被重复注册"


def test_agent_and_skill_standard_pointers_resolve(tmp_path: Path) -> None:
    """Every `standards/<name>.md` pointer in agents and SKILL.md must point at an
    installed standard file. Guards against typo'd or dangling craft-layer pointers."""
    install_claude_assets(tmp_path)

    claude = tmp_path / ".claude"
    standards_dir = claude / "skills" / "loop-engineering" / "standards"
    sources = sorted((claude / "agents").glob("*.md"))
    sources.append(claude / "skills" / "loop-engineering" / "SKILL.md")

    pointer = re.compile(r"standards/([\w-]+)\.md")
    referenced: set[str] = set()
    for src in sources:
        referenced.update(pointer.findall(src.read_text(encoding="utf-8")))

    assert referenced, "expected at least one standards/ pointer in agents or SKILL.md"
    for name in referenced:
        assert (standards_dir / f"{name}.md").is_file(), f"dangling pointer: standards/{name}.md"
