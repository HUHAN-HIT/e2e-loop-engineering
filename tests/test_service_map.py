"""§11.4 service_map 测试."""
from __future__ import annotations

from pathlib import Path

import pytest

from loop_engineering.multi_service.service_map import (
    collect_actual_writes_multi_repo,
    resolve_worktree,
    resolve_worktree_for_task,
    validate_service_map,
)
from loop_engineering.schema.service_contracts import ServiceMap, ServiceMapEntry
from loop_engineering.schema.task_plan import Task


class TestResolveWorktree:
    def test_basic(self) -> None:
        sm = ServiceMap(services={"auth": ServiceMapEntry(worktree="repos/auth")})
        wt = resolve_worktree(sm, "auth")
        assert wt == Path("repos/auth")

    def test_missing_raises(self) -> None:
        sm = ServiceMap(services={"auth": ServiceMapEntry(worktree="repos/auth")})
        with pytest.raises(KeyError):
            resolve_worktree(sm, "billing")


class TestResolveWorktreeForTask:
    def test_none_service_returns_dot(self) -> None:
        sm = ServiceMap(services={})
        t = Task(id="T1", title="t", allowed_write_paths=["a/**"], acceptance_refs=["AC1"])
        assert resolve_worktree_for_task(sm, t) == Path(".")

    def test_with_service(self) -> None:
        sm = ServiceMap(services={"auth": ServiceMapEntry(worktree="repos/auth")})
        t = Task(
            id="T1",
            title="t",
            allowed_write_paths=["a/**"],
            acceptance_refs=["AC1"],
            service="auth",
        )
        assert resolve_worktree_for_task(sm, t) == Path("repos/auth")


class TestValidateServiceMap:
    def test_finds_missing_dirs(self, tmp_path: Path) -> None:
        # tmp_path 下不存在 repos/auth
        sm = ServiceMap(services={"auth": ServiceMapEntry(worktree="repos/auth")})
        problems = validate_service_map(sm, tmp_path)
        assert problems
        assert any("auth" in p for p in problems)

    def test_all_present(self, tmp_path: Path) -> None:
        (tmp_path / "repos" / "auth").mkdir(parents=True)
        sm = ServiceMap(services={"auth": ServiceMapEntry(worktree="repos/auth")})
        problems = validate_service_map(sm, tmp_path)
        assert problems == []


class TestCollectActualWritesMultiRepo:
    def test_combines_services_with_prefix(self) -> None:
        sm = ServiceMap(
            services={
                "auth": ServiceMapEntry(worktree="repos/auth"),
                "gateway": ServiceMapEntry(worktree="repos/gateway"),
            }
        )
        t = Task(
            id="T1",
            title="t",
            allowed_write_paths=["src/**"],
            acceptance_refs=["AC1"],
            service="auth",
        )
        writes = collect_actual_writes_multi_repo(
            sm,
            t,
            collections_by_service={
                "auth": ["src/auth.py", "tests/test_auth.py"],
                "gateway": ["src/gw.py"],
            },
        )
        assert writes == ["repos/auth/src/auth.py", "repos/auth/tests/test_auth.py"]

    def test_none_service_returns_raw(self) -> None:
        sm = ServiceMap(services={})
        t = Task(
            id="T1",
            title="t",
            allowed_write_paths=["src/**"],
            acceptance_refs=["AC1"],
            service=None,
        )
        writes = collect_actual_writes_multi_repo(
            sm, t, collections_by_service={"": ["src/x.py"]}
        )
        assert writes == ["src/x.py"]
