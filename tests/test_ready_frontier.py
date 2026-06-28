"""ready_frontier 单测 (design §3.2).

关键修正 (design §3.2): "候选不仅和 active 比, 还要和本批已选候选两两比"
—— 用 committed = list(active_tasks) + 本批已选实现.
"""
from __future__ import annotations

from loop_engineering.schema.task_plan import Task, TaskStatus
from loop_engineering.scheduling.ready_frontier import ready_frontier


def _task(
    tid: str,
    paths: list[str],
    *,
    status: TaskStatus = TaskStatus.pending,
    depends_on: list[str] | None = None,
    exclusive: bool = False,
    service: str | None = None,
) -> Task:
    return Task(
        id=tid,
        title=tid,
        allowed_write_paths=paths,
        acceptance_refs=[],
        depends_on=depends_on or [],
        exclusive=exclusive,
        service=service,
        status=status,
    )


class TestReadyFrontier:
    def test_picks_pending_only(self) -> None:
        """running / blocked / complete 不被选中."""
        tasks = [
            _task("t-running", ["a/**"], status=TaskStatus.running),
            _task("t-blocked", ["a/**"], status=TaskStatus.blocked),
            _task("t-complete", ["a/**"], status=TaskStatus.complete),
            _task("t-pending", ["b/**"], status=TaskStatus.pending),
        ]
        ready = ready_frontier(tasks, [])
        ids = [t.id for t in ready]
        assert ids == ["t-pending"]

    def test_respects_depends_on(self) -> None:
        """depends_on 未全 complete → 跳过."""
        tasks = [
            _task("t1", ["a/**"]),
            _task("t2", ["b/**"], depends_on=["t1"]),
            _task("t3", ["c/**"], depends_on=["t1"]),
        ]
        # t1 还在 pending, t2/t3 都依赖 t1 → 全跳过 (但 t1 自身可入选).
        ready = ready_frontier(tasks, [])
        ids = [t.id for t in ready]
        assert ids == ["t1"]

    def test_depends_on_satisfied_when_complete(self) -> None:
        """依赖 complete 后可入选."""
        tasks = [
            _task("t1", ["a/**"], status=TaskStatus.complete),
            _task("t2", ["b/**"], depends_on=["t1"]),
        ]
        ready = ready_frontier(tasks, [])
        ids = [t.id for t in ready]
        assert ids == ["t2"]

    def test_skip_if_conflicts_with_active(self) -> None:
        """pending task 与 active task 路径冲突 → 跳过."""
        tasks = [
            _task("t2", ["a/**"]),
        ]
        active = [_task("t1", ["a/x.py"], status=TaskStatus.running)]
        ready = ready_frontier(tasks, active)
        assert ready == []

    def test_skip_if_conflicts_with_committed_in_batch(self) -> None:
        """design §3.2 关键修正: 两个 pending task 互相冲突 → 只选第一个 (字典序)."""
        tasks = [
            _task("alpha", ["shared/x.py"]),
            _task("beta", ["shared/x.py"]),
        ]
        ready = ready_frontier(tasks, [])
        ids = [t.id for t in ready]
        # 字典序: alpha 先选入 committed, beta 与 alpha 冲突 → 跳过.
        assert ids == ["alpha"]

    def test_exclusive_task_blocks_all_committed(self) -> None:
        """exclusive task 与 committed 非空 → 跳过; committed 空 → 入选."""
        # committed 空: exclusive 入选.
        tasks_a = [_task("ex", ["a/**"], exclusive=True)]
        ready_a = ready_frontier(tasks_a, [])
        assert [t.id for t in ready_a] == ["ex"]

        # active 非空: exclusive 跳过.
        active = [_task("other", ["b/**"], status=TaskStatus.running)]
        tasks_b = [_task("ex", ["a/**"], exclusive=True)]
        ready_b = ready_frontier(tasks_b, active)
        assert ready_b == []

    def test_exclusive_task_pushed_by_committed_in_batch(self) -> None:
        """exclusive 与本批先选入的非冲突 task 仍要跳过 (committed 非空)."""
        tasks = [
            _task("aaa", ["a/**"]),                # 字典序在前, 先入选 committed
            _task("zzz", ["b/**"], exclusive=True),  # committed 非空 → 跳过
        ]
        ready = ready_frontier(tasks, [])
        ids = [t.id for t in ready]
        assert ids == ["aaa"]

    def test_batch_ordering_stable(self) -> None:
        """多个可并行 task 按字典序返回."""
        tasks = [
            _task("charlie", ["c/**"]),
            _task("alpha", ["a/**"]),
            _task("bravo", ["b/**"]),
        ]
        ready = ready_frontier(tasks, [])
        ids = [t.id for t in ready]
        assert ids == ["alpha", "bravo", "charlie"]

    def test_selects_independent_tasks_in_parallel(self) -> None:
        """3 个互不冲突 pending task 全选."""
        tasks = [
            _task("t1", ["a/**"]),
            _task("t2", ["b/**"]),
            _task("t3", ["c/**"]),
        ]
        ready = ready_frontier(tasks, [])
        ids = [t.id for t in ready]
        assert ids == ["t1", "t2", "t3"]

    def test_depends_on_index_lookup_by_id(self) -> None:
        """depends_on 是 task id (str), 函数内部反查 Task 对象."""
        tasks = [
            _task("dep", ["a/**"], status=TaskStatus.complete),
            _task("child", ["b/**"], depends_on=["dep"]),
        ]
        ready = ready_frontier(tasks, [])
        assert [t.id for t in ready] == ["child"]

    def test_dangling_dependency_skipped(self) -> None:
        """depends_on 指向不存在 id → 保守跳过."""
        tasks = [
            _task("child", ["b/**"], depends_on=["missing"]),
        ]
        ready = ready_frontier(tasks, [])
        assert ready == []

    def test_empty_inputs(self) -> None:
        """tasks=[] / active_tasks=[] 不报错."""
        assert ready_frontier([], []) == []
        assert ready_frontier([], [_task("a", ["x"])]) == []

    def test_already_active_not_picked_again(self) -> None:
        """active_tasks 里的 task 即使 status=pending (异常情况) 也不被重复选.

        原因: 它在 committed 里, conflicts(自身, 自身) 即 path 与自己重叠 → True.
        """
        active_task = _task("dup", ["a/**"], status=TaskStatus.pending)
        # 注意: 此异常情况仅作防御; 正常 coordinator 不会让 active task 还是 pending.
        # 让 active 列表里有它, 同时 tasks 里也有它.
        tasks = [active_task]
        ready = ready_frontier(tasks, [active_task])
        # dup 在 committed 里, conflicts(dup, dup)=True → 跳过.
        assert ready == []

    def test_cross_service_parallel_picks_both(self) -> None:
        """§11.1: 跨 service 同名路径不冲突, 两 task 同时入选."""
        tasks = [
            _task("auth", ["src/shared.py"], service="auth"),
            _task("gateway", ["src/shared.py"], service="gateway"),
        ]
        ready = ready_frontier(tasks, [])
        ids = [t.id for t in ready]
        assert ids == ["auth", "gateway"]

    def test_exclusive_cross_service_does_not_block_other_service(self) -> None:
        """§11.1: service A 的 exclusive 不阻塞 service B 的 task."""
        tasks = [
            _task("a-migration", ["a/**"], exclusive=True, service="auth"),
            _task("b-task", ["b/**"], service="gateway"),
        ]
        ready = ready_frontier(tasks, [])
        ids = [t.id for t in ready]
        # 字典序 a-migration 先入选; b-task 跨 service 不冲突 → 也入选.
        assert ids == ["a-migration", "b-task"]
