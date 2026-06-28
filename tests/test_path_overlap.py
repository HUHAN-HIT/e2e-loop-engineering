"""path_globs_overlap / conflicts 充分单测 (design §3.2).

design §3.2 原文: "`path_globs_overlap` 无法静态判定时保守返回 True (默认串行).
这是本方案唯一需要谨慎的算法... 至少覆盖: `a/**` vs `a/b.py` (前缀包含)、
`*.py` vs `**` (单层 vs 递归)、`a/*.py` vs `a/b/c.py` (深度差)、否定模式、
以及 '判不准就返 True' 的每条边界 case."
"""
from __future__ import annotations

import pytest

from loop_engineering.schema.task_plan import Task, TaskStatus
from loop_engineering.scheduling.path_overlap import conflicts, path_globs_overlap


# ---------------- path_globs_overlap ----------------

class TestPathGlobsOverlap:
    """design §3.2 点名的所有 case. 判不准一律保守 True."""

    def test_recursive_includes_nested(self) -> None:
        """a/** vs a/b.py → True (前缀包含)."""
        assert path_globs_overlap(["a/**"], ["a/b.py"]) is True

    def test_star_vs_double_star_recursive(self) -> None:
        """*.py vs ** → True (单层 vs 递归)."""
        assert path_globs_overlap(["*.py"], ["**"]) is True

    def test_star_does_not_cross_slash(self) -> None:
        """a/*.py vs a/b/c.py → False (关键: * 不跨 /)."""
        assert path_globs_overlap(["a/*.py"], ["a/b/c.py"]) is False

    def test_double_star_crosses_slash(self) -> None:
        """a/** vs a/b/c/d.py → True (深层文件被递归覆盖)."""
        assert path_globs_overlap(["a/**"], ["a/b/c/d.py"]) is True

    def test_exact_path_match(self) -> None:
        """a/b.py vs a/b.py → True."""
        assert path_globs_overlap(["a/b.py"], ["a/b.py"]) is True

    def test_disjoint_paths(self) -> None:
        """a/** vs b/** → False (互不相交)."""
        assert path_globs_overlap(["a/**"], ["b/**"]) is False

    def test_directory_glob_expands(self) -> None:
        """a (末尾无 /) vs a/b.py → True (目录缩写)."""
        assert path_globs_overlap(["a"], ["a/b.py"]) is True

    def test_negation_pattern_conservative_true(self) -> None:
        """含 !secret/** 的 glob → True (判不准保守串行)."""
        assert path_globs_overlap(["!secret/**"], ["public/x.py"]) is True

    def test_unknown_syntax_conservative_true(self) -> None:
        """含 [abc] 字符类 → True (判不准保守串行)."""
        assert path_globs_overlap(["src/[abc]/x.py"], ["src/b/x.py"]) is True

    def test_empty_globs_do_not_overlap(self) -> None:
        """[] vs ['a/**'] → False (空 allowed_write_paths 永不冲突)."""
        assert path_globs_overlap([], ["a/**"]) is False
        assert path_globs_overlap(["a/**"], []) is False
        assert path_globs_overlap([], []) is False

    def test_multiple_globs_any_overlap(self) -> None:
        """多 glob 列表: 任一 pair 重叠即 True.

        ['a/**', 'y/*'] vs ['b/c.py', 'y/z.py'] → True (y/* 与 y/z.py 重叠).
        同时 a/** 与 b/c.py / y/z.py 互不相交 (不同根).
        """
        # y/* 与 y/z.py 单层重叠.
        assert path_globs_overlap(["a/**", "y/*"], ["b/c.py", "y/z.py"]) is True
        # 对照: 真正不相交时为 False.
        assert path_globs_overlap(["a/**", "x/*"], ["b/c.py", "y/z.py"]) is False

    def test_glob_at_end_matches_files_only(self) -> None:
        """a/** vs a → True (反向: 递归覆盖目录缩写本身)."""
        assert path_globs_overlap(["a/**"], ["a"]) is True

    def test_double_star_middle_matches_zero_levels(self) -> None:
        """a/**/b.py 同时匹配 a/b.py 与 a/x/b.py. 验证与两者都重叠."""
        assert path_globs_overlap(["a/**/b.py"], ["a/b.py"]) is True
        assert path_globs_overlap(["a/**/b.py"], ["a/x/b.py"]) is True

    def test_brace_expansion_conservative_true(self) -> None:
        """含 {a,b} brace 展开 → True (判不准保守)."""
        assert path_globs_overlap(["src/{a,b}/x.py"], ["src/a/x.py"]) is True


# ---------------- conflicts ----------------

class TestConflicts:
    """conflicts (design §3.2 + §11.1 C2 修复)."""

    def _task(
        self,
        tid: str,
        paths: list[str],
        *,
        exclusive: bool = False,
        service: str | None = None,
    ) -> Task:
        return Task(
            id=tid,
            title=tid,
            allowed_write_paths=paths,
            acceptance_refs=[],
            exclusive=exclusive,
            service=service,
        )

    def test_conflicts_same_service_path_overlap(self) -> None:
        a = self._task("a", ["src/auth/**"], service="auth")
        b = self._task("b", ["src/auth/login.py"], service="auth")
        assert conflicts(a, b) is True

    def test_conflicts_same_service_no_overlap(self) -> None:
        a = self._task("a", ["src/auth/**"], service="auth")
        b = self._task("b", ["src/gateway/**"], service="auth")
        assert conflicts(a, b) is False

    def test_conflicts_cross_service_never(self) -> None:
        """§11.1 C2: 跨服务永不冲突, 即使路径同名."""
        a = self._task("a", ["src/shared.py"], service="auth")
        b = self._task("b", ["src/shared.py"], service="gateway")
        assert conflicts(a, b) is False

    def test_conflicts_exclusive_same_service(self) -> None:
        a = self._task("a", ["src/auth/**"], exclusive=True, service="auth")
        b = self._task("b", ["src/gateway/**"], service="auth")
        assert conflicts(a, b) is True

    def test_conflicts_exclusive_cross_service(self) -> None:
        """§11.1: exclusive 不跨服务独占. 跨 service 即使 exclusive 也 False."""
        a = self._task("a", ["src/**"], exclusive=True, service="auth")
        b = self._task("b", ["src/**"], service="gateway")
        assert conflicts(a, b) is False

    def test_conflicts_no_service_treated_as_same(self) -> None:
        """双方 service=None → 按同服务判."""
        a = self._task("a", ["src/**"])
        b = self._task("b", ["src/x.py"])
        assert conflicts(a, b) is True

    def test_conflicts_mixed_service_null(self) -> None:
        """service=None vs service='auth' → 任一 None 视为同服务."""
        a = self._task("a", ["src/**"], service=None)
        b = self._task("b", ["src/x.py"], service="auth")
        assert conflicts(a, b) is True

    def test_conflicts_both_exclusive_same_service(self) -> None:
        a = self._task("a", ["x"], exclusive=True, service="auth")
        b = self._task("b", ["y"], exclusive=True, service="auth")
        assert conflicts(a, b) is True
