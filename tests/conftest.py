"""Shared pytest fixtures.

提供 tmp run 目录、最小 task-plan 样本、最小 run-state 样本等公共 fixture.
subagent 实现具体 fixture 时按需扩展; 此处只给最基础的 tmp_path 包装.
"""
from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture
def tmp_runs_root(tmp_path: Path) -> Path:
    """临时 runs/ 根目录, 每个测试函数独立一份."""
    root = tmp_path / "runs"
    root.mkdir()
    return root


@pytest.fixture
def tmp_run_dir(tmp_runs_root: Path) -> Path:
    """单个 run 目录 (runs/20260627-001/), 含子目录骨架."""
    run = tmp_runs_root / "20260627-001"
    for sub in ("input", "clarification", "planning", "wrap-up"):
        (run / sub).mkdir(parents=True)
    (run / "tasks").mkdir(parents=True)
    return run
