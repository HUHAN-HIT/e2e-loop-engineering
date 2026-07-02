/**
 * dispatch 单元测试: buildPacket / collectOutcome / worker_runner。
 *
 * 行为权威: Python `loop_engineering/dispatch/{packet,collect,worker_runner}.py`
 * (Python 端这些由 test_integration_dry_run.py 端到端覆盖, 此处补直接单元用例)。
 * 被测实现: `packages/ssot-ts/src/dispatch/*`。
 */
import { test, expect } from "bun:test";

import {
  InlineWorkerRunner,
  RecordingWorkerRunner,
  buildPacket,
  collectActualWrites,
  collectOutcome,
  detectOutOfBounds,
  makeWorkerOutcome,
} from "../../packages/ssot-ts/src/dispatch/index.js";
import type { WorkerPacket } from "../../packages/ssot-ts/src/dispatch/index.js";
import { parseTaskPlan } from "../../packages/ssot-ts/src/schema/task_plan.js";
import type { Task } from "../../packages/ssot-ts/src/schema/task_plan.js";

function plan2(): ReturnType<typeof parseTaskPlan> {
  return parseTaskPlan({
    complexity: "simple",
    tasks: [
      {
        id: "T01",
        title: "dep",
        allowed_write_paths: ["src/a/**"],
        acceptance_refs: ["AC-001"],
        tests: [{ id: "t1", scenario: "happy", checks: ["passed == true"] }],
      },
      {
        id: "T02",
        title: "main",
        allowed_write_paths: ["src/b/**"],
        acceptance_refs: ["AC-002"],
        depends_on: ["T01"],
        tests: [{ id: "t2", scenario: "happy", checks: ["passed == true"] }],
      },
    ],
  });
}

const NO_CAP = { git_diff: false, fs_snapshot: false };

// ---------------------------------------------------------------------------
// buildPacket
// ---------------------------------------------------------------------------

test("[py: build_packet] 依赖 task 的 summary.md 进 dependency_artifacts; context_paths = design + task-plan", () => {
  const plan = plan2();
  const t02 = plan.tasks.find((t) => t.id === "T02")!;
  const packet = buildPacket(t02, plan, "/runs/r1", {
    designMd: "/runs/r1/planning/design.md",
    taskPlanYaml: "/runs/r1/planning/task-plan.yaml",
    workdir: "/code",
  });
  expect(packet.task_id).toBe("T02");
  expect(packet.context_paths).toEqual([
    "/runs/r1/planning/design.md",
    "/runs/r1/planning/task-plan.yaml",
  ]);
  // 依赖 T01 → tasks/T01/summary.md。
  expect(packet.dependency_artifacts.some((p) => p.includes("T01") && p.endsWith("summary.md"))).toBe(
    true,
  );
  expect(packet.allowed_write_paths).toEqual(["src/b/**"]);
  expect(packet.planned_test_cases.map((c) => c.id)).toEqual(["t2"]);
  expect(packet.workdir).toBe("/code");
});

test("[detail] buildPacket 将当前 task 的 detail_ref 放到 context_paths 第一位并暴露 task_detail_path", () => {
  const plan = parseTaskPlan({
    complexity: "complex",
    tasks: [
      {
        id: "T01",
        title: "detail task",
        detail_ref: "planning/task-details/T01.yaml",
        allowed_write_paths: ["src/auth/**"],
        acceptance_refs: ["AC-001"],
        tests: [{ id: "T01-CASE-001", scenario: "happy", checks: ["passed == true"] }],
      },
    ],
  });
  const packet = buildPacket(plan.tasks[0]!, plan, "/runs/r1", {
    designMd: "/runs/r1/planning/design.md",
    taskPlanYaml: "/runs/r1/planning/task-plan.yaml",
    workdir: "/code",
  });
  expect(packet.context_paths).toEqual([
    "/runs/r1/planning/task-details/T01.yaml",
    "/runs/r1/planning/design.md",
    "/runs/r1/planning/task-plan.yaml",
  ]);
  expect(packet.task_detail_path).toBe("/runs/r1/planning/task-details/T01.yaml");
  expect(packet.task_detail_required).toBe(false);
});

test("[py: build_packet] 无依赖 task → dependency_artifacts 为空", () => {
  const plan = plan2();
  const t01 = plan.tasks.find((t) => t.id === "T01")!;
  const packet = buildPacket(t01, plan, "/runs/r1", {
    designMd: "d.md",
    taskPlanYaml: "tp.yaml",
  });
  expect(packet.dependency_artifacts).toEqual([]);
});

// ---------------------------------------------------------------------------
// worker_runner
// ---------------------------------------------------------------------------

test("[py: InlineWorkerRunner] callback 注入 → dispatch 透传 outcome", () => {
  const runner = new InlineWorkerRunner((p: WorkerPacket) =>
    makeWorkerOutcome({ status: "completed", summary_text: `for ${p.task_id}` }),
  );
  const packet = buildPacket(plan2().tasks[0]!, plan2(), "/r", {
    designMd: "d",
    taskPlanYaml: "tp",
  });
  const out = runner.dispatch(packet);
  expect(out.status).toBe("completed");
  expect(out.summary_text).toBe("for T01");
});

test("[py: RecordingWorkerRunner] 按序消费预置队列; 耗尽 → 抛", () => {
  const runner = new RecordingWorkerRunner([makeWorkerOutcome({ status: "completed" })]);
  const packet = buildPacket(plan2().tasks[0]!, plan2(), "/r", {
    designMd: "d",
    taskPlanYaml: "tp",
  });
  expect(runner.dispatch(packet).status).toBe("completed");
  expect(runner.dispatchedPackets.length).toBe(1);
  expect(() => runner.dispatch(packet)).toThrow("队列耗尽");
});

// ---------------------------------------------------------------------------
// collectOutcome (无独立采集能力时: actual_writes 空集 + 任务自检走 eval_result)
// ---------------------------------------------------------------------------

test("[py: collect_outcome] tests_green 用 eval_result (不信 worker 自报); 全绿 → 任务自检通过", () => {
  const plan = plan2();
  const t01 = plan.tasks.find((t) => t.id === "T01")!;
  const packet = buildPacket(t01, plan, "/r", { designMd: "d", taskPlanYaml: "tp" });
  const outcome = makeWorkerOutcome({
    status: "completed",
    test_results: { tests_green: true, cases: [{ id: "t1", passed: true, failure_reason: "" }] },
  });
  const collected = collectOutcome(t01, outcome, packet, NO_CAP);

  expect(collected.eval_result.tests_green).toBe(true);
  expect(collected.task_check_result.all_pass).toBe(true);
  // 无 git/fs 能力 → self_report 空集, 不越界。
  expect(collected.actual_writes.source).toBe("worker_self_report");
  expect(collected.actual_writes.is_authoritative).toBe(false);
  expect(collected.oob.is_oob).toBe(false);
});

test("[py: collect_outcome] worker 自报 tests_green=true 但 case 红 → eval_result 判红, 自检不通过", () => {
  const plan = plan2();
  const t01 = plan.tasks.find((t) => t.id === "T01")!;
  const packet = buildPacket(t01, plan, "/r", { designMd: "d", taskPlanYaml: "tp" });
  // 自报 green, 但 case passed=false → checks `passed == true` 求值为 false。
  const outcome = makeWorkerOutcome({
    status: "completed",
    test_results: { tests_green: true, cases: [{ id: "t1", passed: false, failure_reason: "boom" }] },
  });
  const collected = collectOutcome(t01, outcome, packet, NO_CAP);
  expect(collected.eval_result.tests_green).toBe(false);
  expect(collected.task_check_result.all_pass).toBe(false);
});

test("[py: collect_outcome] failed outcome (test_results=null) → 全 fail 兜底, 自检不通过", () => {
  const plan = plan2();
  const t01 = plan.tasks.find((t) => t.id === "T01")!;
  const packet = buildPacket(t01, plan, "/r", { designMd: "d", taskPlanYaml: "tp" });
  const outcome = makeWorkerOutcome({ status: "failed", failure_reason: "crash" });
  const collected = collectOutcome(t01, outcome, packet, NO_CAP);
  expect(collected.eval_result.tests_green).toBe(false);
  expect(collected.task_check_result.all_pass).toBe(false);
});

// ---------------------------------------------------------------------------
// detectOutOfBounds (经 collectOutcome 的 self_report 路径 + fs 采集语义)
// ---------------------------------------------------------------------------

test("[py: collect_via_fs_snapshot + detect_out_of_bounds] fs 能力下 越界路径被抓", () => {
  // 用内存 fs 快照直接验证采集 + 越界 (workdir 不必真实存在, before/after 内存对比即可)。
  const task: Task = parseTaskPlan({
    complexity: "simple",
    tasks: [{ id: "T01", title: "t", allowed_write_paths: ["src/**"], acceptance_refs: ["AC"] }],
  }).tasks[0]!;
  const before = { "src/a.ts": 1 };
  const after = { "src/a.ts": 2, "secret/leak.ts": 9 };
  const writes = collectActualWrites("/nonexistent", "T01", { git_diff: false, fs_snapshot: true }, {
    beforeSnapshot: before,
    afterSnapshot: after,
  });
  expect(writes.source).toBe("fs_snapshot");
  expect(writes.writes.sort()).toEqual(["secret/leak.ts", "src/a.ts"]);
  const oob = detectOutOfBounds(task, writes, {});
  expect(oob.is_oob).toBe(true);
  expect(oob.out_of_bounds).toEqual(["secret/leak.ts"]);
});
