/**
 * ready_frontier 等价测试 (P4-M3, design §3.2)。
 *
 * 行为权威: Python `tests/test_ready_frontier.py` + `loop_engineering/scheduling/ready_frontier.py`。
 * 被测实现: `packages/ssot-ts/src/scheduling/ready_frontier.ts`。
 *
 * 关键修正 (design §3.2): "候选不仅和 active 比, 还要和本批已选候选两两比"。
 */
import { test, expect } from "bun:test";

import { readyFrontier } from "../../packages/ssot-ts/src/scheduling/ready_frontier.js";
import { TaskSchema, TaskStatus } from "../../packages/ssot-ts/src/schema/task_plan.js";
import type { Task } from "../../packages/ssot-ts/src/schema/task_plan.js";

/** 构造测试 task (经 zod 补默认值)。 */
function makeTask(
  tid: string,
  paths: string[],
  opts: {
    status?: TaskStatus;
    dependsOn?: string[];
    exclusive?: boolean;
    service?: string | null;
  } = {},
): Task {
  return TaskSchema.parse({
    id: tid,
    title: tid,
    allowed_write_paths: paths,
    acceptance_refs: [],
    depends_on: opts.dependsOn ?? [],
    exclusive: opts.exclusive ?? false,
    service: opts.service ?? null,
    status: opts.status ?? TaskStatus.pending,
  });
}

test("[py: test_picks_pending_only] running / blocked / complete 不被选中", () => {
  const tasks = [
    makeTask("t-running", ["a/**"], { status: TaskStatus.running }),
    makeTask("t-blocked", ["a/**"], { status: TaskStatus.blocked }),
    makeTask("t-complete", ["a/**"], { status: TaskStatus.complete }),
    makeTask("t-pending", ["b/**"], { status: TaskStatus.pending }),
  ];
  const ready = readyFrontier(tasks, []);
  expect(ready.map((t) => t.id)).toEqual(["t-pending"]);
});

test("[py: test_respects_depends_on] depends_on 未全 complete → 跳过 (但 t1 自身可入选)", () => {
  const tasks = [
    makeTask("t1", ["a/**"]),
    makeTask("t2", ["b/**"], { dependsOn: ["t1"] }),
    makeTask("t3", ["c/**"], { dependsOn: ["t1"] }),
  ];
  const ready = readyFrontier(tasks, []);
  expect(ready.map((t) => t.id)).toEqual(["t1"]);
});

test("[py: test_depends_on_satisfied_when_complete] 依赖 complete 后可入选", () => {
  const tasks = [
    makeTask("t1", ["a/**"], { status: TaskStatus.complete }),
    makeTask("t2", ["b/**"], { dependsOn: ["t1"] }),
  ];
  const ready = readyFrontier(tasks, []);
  expect(ready.map((t) => t.id)).toEqual(["t2"]);
});

test("[py: test_skip_if_conflicts_with_active] 与 active task 路径冲突 → 跳过", () => {
  const tasks = [makeTask("t2", ["a/**"])];
  const active = [makeTask("t1", ["a/x.py"], { status: TaskStatus.running })];
  const ready = readyFrontier(tasks, active);
  expect(ready).toEqual([]);
});

test("[py: test_skip_if_conflicts_with_committed_in_batch] 两 pending 互冲突 → 只选字典序首个", () => {
  const tasks = [
    makeTask("alpha", ["shared/x.py"]),
    makeTask("beta", ["shared/x.py"]),
  ];
  const ready = readyFrontier(tasks, []);
  expect(ready.map((t) => t.id)).toEqual(["alpha"]);
});

test("[py: test_exclusive_task_blocks_all_committed] committed 空 → exclusive 入选; 非空 → 跳过", () => {
  // committed 空: exclusive 入选。
  const readyA = readyFrontier([makeTask("ex", ["a/**"], { exclusive: true })], []);
  expect(readyA.map((t) => t.id)).toEqual(["ex"]);

  // active 非空: exclusive 跳过。
  const active = [makeTask("other", ["b/**"], { status: TaskStatus.running })];
  const readyB = readyFrontier([makeTask("ex", ["a/**"], { exclusive: true })], active);
  expect(readyB).toEqual([]);
});

test("[py: test_exclusive_task_pushed_by_committed_in_batch] exclusive 因本批已选非空而跳过", () => {
  const tasks = [
    makeTask("aaa", ["a/**"]), // 字典序在前, 先入选 committed
    makeTask("zzz", ["b/**"], { exclusive: true }), // committed 非空 → 跳过
  ];
  const ready = readyFrontier(tasks, []);
  expect(ready.map((t) => t.id)).toEqual(["aaa"]);
});

test("[py: test_batch_ordering_stable] 多个可并行 task 按字典序返回", () => {
  const tasks = [
    makeTask("charlie", ["c/**"]),
    makeTask("alpha", ["a/**"]),
    makeTask("bravo", ["b/**"]),
  ];
  const ready = readyFrontier(tasks, []);
  expect(ready.map((t) => t.id)).toEqual(["alpha", "bravo", "charlie"]);
});

test("[py: test_selects_independent_tasks_in_parallel] 3 个互不冲突 pending 全选", () => {
  const tasks = [
    makeTask("t1", ["a/**"]),
    makeTask("t2", ["b/**"]),
    makeTask("t3", ["c/**"]),
  ];
  const ready = readyFrontier(tasks, []);
  expect(ready.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
});

test("[py: test_depends_on_index_lookup_by_id] depends_on 是 id, 内部反查 Task", () => {
  const tasks = [
    makeTask("dep", ["a/**"], { status: TaskStatus.complete }),
    makeTask("child", ["b/**"], { dependsOn: ["dep"] }),
  ];
  const ready = readyFrontier(tasks, []);
  expect(ready.map((t) => t.id)).toEqual(["child"]);
});

test("[py: test_dangling_dependency_skipped] depends_on 指向不存在 id → 保守跳过", () => {
  const tasks = [makeTask("child", ["b/**"], { dependsOn: ["missing"] })];
  const ready = readyFrontier(tasks, []);
  expect(ready).toEqual([]);
});

test("[py: test_empty_inputs] tasks=[] / active=[] 不报错", () => {
  expect(readyFrontier([], [])).toEqual([]);
  expect(readyFrontier([], [makeTask("a", ["x"])])).toEqual([]);
});

test("[py: test_already_active_not_picked_again] active 里的 task 不被重复选 (自冲突)", () => {
  const activeTask = makeTask("dup", ["a/**"], { status: TaskStatus.pending });
  const ready = readyFrontier([activeTask], [activeTask]);
  // dup 在 committed 里, conflicts(dup, dup)=True → 跳过。
  expect(ready).toEqual([]);
});

test("[py: test_cross_service_parallel_picks_both] §11.1: 跨 service 同名路径不冲突, 两 task 同入选", () => {
  const tasks = [
    makeTask("auth", ["src/shared.py"], { service: "auth" }),
    makeTask("gateway", ["src/shared.py"], { service: "gateway" }),
  ];
  const ready = readyFrontier(tasks, []);
  expect(ready.map((t) => t.id)).toEqual(["auth", "gateway"]);
});

test("[py: test_exclusive_cross_service_does_not_block_other_service] §11.1: A 的 exclusive 不阻塞 B", () => {
  const tasks = [
    makeTask("a-migration", ["a/**"], { exclusive: true, service: "auth" }),
    makeTask("b-task", ["b/**"], { service: "gateway" }),
  ];
  const ready = readyFrontier(tasks, []);
  // 字典序 a-migration 先入选; b-task 跨 service 不冲突 → 也入选。
  expect(ready.map((t) => t.id)).toEqual(["a-migration", "b-task"]);
});
