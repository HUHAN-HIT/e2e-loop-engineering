"""Claude Code asset installation tests."""
from __future__ import annotations

from pathlib import Path

from loop_engineering.claude_assets import install_claude_assets


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
