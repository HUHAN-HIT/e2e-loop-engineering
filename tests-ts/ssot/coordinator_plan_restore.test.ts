/**
 * 回归测试: Coordinator 跨进程恢复 plan + 单写者持久化 + 端到端 simple run。
 *
 * 行为权威: Python `tests/test_coordinator_plan_restore.py` +
 * `tests/test_integration_dry_run.py` (端到端闭环子集)。
 * 被测实现: `packages/ssot-ts/src/runtime/coordinator.ts`。
 *
 * 背景 (跨进程恢复): CLI 每个子命令都新建 Coordinator, 只 readRunState 恢复 state。
 * 若不从 planning/task-plan.yaml 恢复 plan, 则 run/wrap-up 命令重建后 plan=null,
 * runTick 抛 "plan 为空"。本测试固化恢复行为。
 */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  Coordinator,
  initRunDir,
  readRunState,
  writeRunState,
  writeTaskPlan,
} from "../../packages/ssot-ts/src/runtime/index.js";
import {
  InlineWorkerRunner,
  RecordingWorkerRunner,
  makeWorkerOutcome,
} from "../../packages/ssot-ts/src/dispatch/index.js";
import type { WorkerOutcome } from "../../packages/ssot-ts/src/dispatch/index.js";
import { parseRunState, HumanPending, Phase } from "../../packages/ssot-ts/src/schema/run_state.js";
import { parseTaskPlan } from "../../packages/ssot-ts/src/schema/task_plan.js";
import type { TaskPlan } from "../../packages/ssot-ts/src/schema/task_plan.js";

/** 临时 runs 根目录 (用后即清)。 */
function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loop-coord-"));
}

function noopWorker(): WorkerOutcome {
  return makeWorkerOutcome({ status: "completed" });
}

/** 构造 minimal plan: 1 task, 1 AC, 1 happy-path test。 */
function simplePlan(opts?: { riskHigh?: boolean; exclusive?: boolean; withTests?: boolean }): TaskPlan {
  const riskHigh = opts?.riskHigh ?? false;
  const withTests = opts?.withTests ?? true;
  return parseTaskPlan({
    complexity: "simple",
    tasks: [
      {
        id: "T01",
        title: "simple task",
        allowed_write_paths: ["src/**"],
        acceptance_refs: ["AC-001"],
        depends_on: [],
        exclusive: opts?.exclusive ?? false,
        risk: riskHigh ? "high" : "normal",
        tests: withTests
          ? [{ id: "t1_happy", scenario: "happy path", checks: ["passed == true"] }]
          : [],
      },
    ],
  });
}

/** completed outcome (tests_green=true, 1 passed case)。withKeyDiffs 时附带非空 key-diffs。 */
function completedOutcome(withKeyDiffs = false, taskId = "T01"): WorkerOutcome {
  return makeWorkerOutcome({
    status: "completed",
    test_results: { tests_green: true, cases: [{ id: "t1_happy", passed: true, failure_reason: "" }] },
    summary_text: "done",
    key_diffs_file: withKeyDiffs
      ? {
          schema: "loop-engineering.key-diffs.v1",
          task_id: taskId,
          key_diffs: [{ file: "src/x.ts", change: "add x", why: "for AC-001", risk: "low" }],
        }
      : null,
  });
}

// ---------------------------------------------------------------------------
// 跨进程恢复 plan (test_coordinator_plan_restore.py)
// ---------------------------------------------------------------------------

test("[py: test_coordinator_restores_plan_from_disk] 已落盘 task-plan.yaml → 新建 Coordinator 恢复 plan", () => {
  const runsRoot = path.join(makeTmp(), "runs");
  const runId = "20260627-001";
  const runDir = initRunDir(runsRoot, runId, "需求: smoke");
  writeRunState(
    runDir,
    parseRunState({ run_id: runId, complexity: "simple", phase: Phase.IMPLEMENTING }),
  );
  const plan = parseTaskPlan({
    complexity: "simple",
    tasks: [
      { id: "T01", title: "smoke", allowed_write_paths: ["src/**"], acceptance_refs: ["AC-001"] },
    ],
  });
  writeTaskPlan(path.join(runDir, "planning", "task-plan.yaml"), plan);

  const coord = new Coordinator(runDir, new InlineWorkerRunner(noopWorker));

  expect(coord.plan).not.toBeNull();
  expect(coord.plan!.tasks.map((t) => t.id)).toEqual(["T01"]);
});

test("[py: test_coordinator_plan_none_when_no_plan_file] 无 task-plan.yaml (CREATED) → plan=null", () => {
  const runsRoot = path.join(makeTmp(), "runs");
  const runId = "20260627-002";
  const runDir = initRunDir(runsRoot, runId, "需求: smoke");
  writeRunState(
    runDir,
    parseRunState({ run_id: runId, complexity: "simple", phase: Phase.CREATED }),
  );

  const coord = new Coordinator(runDir, new InlineWorkerRunner(noopWorker));

  expect(coord.plan).toBeNull();
});

// ---------------------------------------------------------------------------
// 端到端 simple run (test_integration_dry_run.py::test_end_to_end_simple_run)
// ---------------------------------------------------------------------------

test("[py: test_end_to_end_simple_run] CREATED→PLANNING→IMPLEMENTING→WRAPPING_UP→COMPLETE 闭环", () => {
  const runsRoot = path.join(makeTmp(), "runs");
  const runId = "20260627-001";
  const runDir = initRunDir(runsRoot, runId, "test requirement");
  writeRunState(runDir, parseRunState({ run_id: runId, complexity: "simple", phase: Phase.CREATED }));

  const runner = new RecordingWorkerRunner([completedOutcome(true)]);
  const coord = new Coordinator(runDir, runner);

  // 1. CREATED → PLANNING
  coord.startPlanning();
  expect(coord.state.phase).toBe(Phase.PLANNING);

  // 2. 提交 plan + signoff
  coord.submitPlan(simplePlan());
  expect(coord.state.human_pending).toBe(HumanPending.plan_signoff);
  coord.signoffPlan(true);
  expect(coord.state.phase).toBe(Phase.IMPLEMENTING);
  expect(coord.state.human_pending ?? null).toBeNull();

  // 3. 跑 tick 循环
  coord.runUntilHumanOrTerminal(10);

  expect(coord.plan).not.toBeNull();
  expect(coord.plan!.tasks[0]!.status).toBe("complete");
  expect(coord.state.phase).toBe(Phase.COMPLETE);
  expect(coord.state.human_pending ?? null).toBeNull();

  // 4. 收口自检通过, check-result.json 含 all_tasks_tests_green
  const result = fs.readFileSync(path.join(runDir, "wrap-up", "check-result.json"), "utf-8");
  expect(result).toContain("all_tasks_tests_green");

  // 5. 普通全绿 run 自动 COMPLETE, 不再等待 wrap_up_signoff。
  const persisted = readRunState(runDir);
  expect(persisted.phase).toBe(Phase.COMPLETE);
  expect(persisted.human_pending ?? null).toBeNull();
});

// ---------------------------------------------------------------------------
// abort during planning (test_abort_during_planning)
// ---------------------------------------------------------------------------

test("[py: test_abort_during_planning] PLANNING abort → ABORTED + aborted_at/reason 持久化", () => {
  const runsRoot = path.join(makeTmp(), "runs");
  const runId = "20260627-001";
  const runDir = initRunDir(runsRoot, runId, "test");
  writeRunState(runDir, parseRunState({ run_id: runId, complexity: "simple", phase: Phase.CREATED }));

  const coord = new Coordinator(runDir, new RecordingWorkerRunner([]));
  coord.startPlanning();
  expect(coord.state.phase).toBe(Phase.PLANNING);

  coord.abort("人主动放弃 (test)");
  expect(coord.state.phase).toBe(Phase.ABORTED);
  expect(coord.state.aborted_at).not.toBeNull();
  expect(coord.state.aborted_reason).toBe("人主动放弃 (test)");

  const persisted = readRunState(runDir);
  expect(persisted.phase).toBe(Phase.ABORTED);
  expect(persisted.aborted_reason).toBe("人主动放弃 (test)");
  expect(persisted.aborted_at).not.toBeNull();
});

// ---------------------------------------------------------------------------
// plan amendment during implementing (test_plan_amendment_during_implementing)
// ---------------------------------------------------------------------------

test("[py: test_plan_amendment_during_implementing] worker 返回 plan_amendment → 回滚 + 回 PLANNING", () => {
  const runsRoot = path.join(makeTmp(), "runs");
  const runId = "20260627-001";
  const runDir = initRunDir(runsRoot, runId, "test");
  writeRunState(runDir, parseRunState({ run_id: runId, complexity: "simple", phase: Phase.CREATED }));

  const amendment = {
    status: "plan-amendment-needed" as const,
    reason: "planned 用例 t1_happy 在实际代码中不可执行",
    touched_acceptance_refs: ["AC-001"],
  };
  const runner = new RecordingWorkerRunner([
    makeWorkerOutcome({ status: "plan_amendment", plan_amendment: amendment }),
  ]);
  const coord = new Coordinator(runDir, runner);
  coord.startPlanning();
  coord.submitPlan(simplePlan());
  coord.signoffPlan(true);
  expect(coord.state.phase).toBe(Phase.IMPLEMENTING);

  coord.runTick();

  expect(coord.state.phase).toBe(Phase.PLANNING);
  expect(coord.state.human_pending).toBe(HumanPending.plan_signoff);
  expect(coord.plan).not.toBeNull();
  // T01 在 plan-amendment 后应回 pending (rollback recall running→pending)
  expect(coord.plan!.tasks[0]!.status).toBe("pending");
});

// ---------------------------------------------------------------------------
// hard gate missing key-diffs blocks COMPLETE (test_hard_gate_task_missing_key_diffs_blocks_complete)
// ---------------------------------------------------------------------------

test("[py: test_hard_gate_task_missing_key_diffs_blocks_complete] risk:high 缺 key-diffs → 收口自检 fail", () => {
  const runsRoot = path.join(makeTmp(), "runs");
  const runId = "20260627-001";
  const runDir = initRunDir(runsRoot, runId, "test");
  writeRunState(runDir, parseRunState({ run_id: runId, complexity: "simple", phase: Phase.CREATED }));

  const runner = new RecordingWorkerRunner([completedOutcome(false)]);
  const coord = new Coordinator(runDir, runner);
  coord.startPlanning();
  coord.submitPlan(simplePlan({ riskHigh: true }));
  coord.signoffPlan(true);

  coord.runUntilHumanOrTerminal(10);

  expect(coord.state.phase).toBe(Phase.WRAPPING_UP);
  expect(coord.state.human_pending).toBe(HumanPending.wrap_up_signoff);

  const result = fs.readFileSync(path.join(runDir, "wrap-up", "check-result.json"), "utf-8");
  expect(result).toContain("all_hard_gates_pass");
  const items = JSON.parse(result) as Array<{ check: string; passed: boolean }>;
  const hardGate = items.find((i) => i.check === "all_hard_gates_pass")!;
  expect(hardGate.passed).toBe(false);

  // 校验未通过时拒绝 accepted 签收。
  expect(() => coord.signoffWrapUp(true)).toThrow();
});

test("risk:high 有 key-diffs 且收口自检通过 → 保留 wrap_up_signoff, 不自动 COMPLETE", () => {
  const runsRoot = path.join(makeTmp(), "runs");
  const runId = "20260627-high-review";
  const runDir = initRunDir(runsRoot, runId, "test high risk");
  writeRunState(runDir, parseRunState({ run_id: runId, complexity: "simple", phase: Phase.CREATED }));

  const runner = new RecordingWorkerRunner([completedOutcome(true)]);
  const coord = new Coordinator(runDir, runner);
  coord.startPlanning();
  coord.submitPlan(simplePlan({ riskHigh: true }));
  coord.signoffPlan(true);

  coord.runUntilHumanOrTerminal(10);

  expect(coord.state.phase).toBe(Phase.WRAPPING_UP);
  expect(coord.state.human_pending).toBe(HumanPending.wrap_up_signoff);

  const result = fs.readFileSync(path.join(runDir, "wrap-up", "check-result.json"), "utf-8");
  const items = JSON.parse(result) as Array<{ check: string; passed: boolean }>;
  expect(items.every((i) => i.passed)).toBe(true);
});

test("exclusive task 有 key-diffs 且收口自检通过 → 保留 wrap_up_signoff, 不自动 COMPLETE", () => {
  const runsRoot = path.join(makeTmp(), "runs");
  const runId = "20260627-exclusive-review";
  const runDir = initRunDir(runsRoot, runId, "test exclusive");
  writeRunState(runDir, parseRunState({ run_id: runId, complexity: "simple", phase: Phase.CREATED }));

  const runner = new RecordingWorkerRunner([completedOutcome(true)]);
  const coord = new Coordinator(runDir, runner);
  coord.startPlanning();
  coord.submitPlan(simplePlan({ exclusive: true }));
  coord.signoffPlan(true);

  coord.runUntilHumanOrTerminal(10);

  expect(coord.state.phase).toBe(Phase.WRAPPING_UP);
  expect(coord.state.human_pending).toBe(HumanPending.wrap_up_signoff);
});

// ---------------------------------------------------------------------------
// 单写者持久化: tick 后 plan 落盘且可被新 Coordinator 读回
// ---------------------------------------------------------------------------

test("[新增] 单写者持久化: tick 后 task-plan.yaml 落盘, 新 Coordinator 读回状态一致", () => {
  const runsRoot = path.join(makeTmp(), "runs");
  const runId = "20260627-001";
  const runDir = initRunDir(runsRoot, runId, "test");
  writeRunState(runDir, parseRunState({ run_id: runId, complexity: "simple", phase: Phase.CREATED }));

  const runner = new RecordingWorkerRunner([completedOutcome(true)]);
  const coord = new Coordinator(runDir, runner);
  coord.startPlanning();
  coord.submitPlan(simplePlan());
  coord.signoffPlan(true);
  coord.runUntilHumanOrTerminal(10);

  // 落盘的 task-plan.yaml 应能被新 Coordinator 读回, task 状态 complete。
  const coord2 = new Coordinator(runDir, new RecordingWorkerRunner([]));
  expect(coord2.plan).not.toBeNull();
  expect(coord2.plan!.tasks[0]!.status).toBe("complete");
  expect(coord2.state.phase).toBe(Phase.COMPLETE);

  // 落盘的 run-state.json 不含 null 字段 (exclude_none 对齐)。
  const raw = fs.readFileSync(path.join(runDir, "run-state.json"), "utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  expect(Object.values(parsed).every((v) => v !== null)).toBe(true);
});
