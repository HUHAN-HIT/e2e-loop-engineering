/**
 * tick 固定顺序 (design §3.7) + directory 原子写重试 等价/关键用例。
 *
 * 行为权威: Python `loop_engineering/runtime/tick.py` + `runtime/directory.py` +
 * `tests/test_integration_dry_run.py` (watchdog recycle 子集)。
 * 被测实现: `packages/ssot-ts/src/runtime/tick.ts` + `directory.ts`。
 *
 * 覆盖:
 * - tick 固定顺序: ① ABORTED 短路 ② 收回 outcome→complete ③ watchdog 回收 ④ readyFrontier 派发。
 * - 仅 IMPLEMENTING phase 才走 readyFrontier 派发。
 * - plan_amendment 透传 (tick 自身不回滚)。
 * - watchdog recycle: 超时 → attempt+1 + stale_count+1 + watchdog.json timeout 事件。
 * - directory 原子写: writeRunState 重试逻辑 + exclude_none; atomicReplace 失败重试。
 */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { tick } from "../../packages/ssot-ts/src/runtime/tick.js";
import type { TickRuntime } from "../../packages/ssot-ts/src/runtime/tick.js";
import {
  atomicReplace,
  initRunDir,
  readRunState,
  writeRunState,
} from "../../packages/ssot-ts/src/runtime/index.js";
import {
  RecordingWorkerRunner,
  makeWorkerOutcome,
} from "../../packages/ssot-ts/src/dispatch/index.js";
import type { WorkerOutcome } from "../../packages/ssot-ts/src/dispatch/index.js";
import { parseRunState, Phase } from "../../packages/ssot-ts/src/schema/run_state.js";
import type { RunState } from "../../packages/ssot-ts/src/schema/run_state.js";
import { parseTaskPlan } from "../../packages/ssot-ts/src/schema/task_plan.js";
import type { TaskPlan } from "../../packages/ssot-ts/src/schema/task_plan.js";

/** 临时 run 目录。 */
function makeTmpRunDir(): string {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loop-tick-"));
  return initRunDir(runsRoot, "20260627-001", "tick test");
}

/** 全新 runtime map 包。 */
function freshRuntime(): TickRuntime {
  return {
    startedAtByTask: new Map(),
    staleCountByTask: new Map(),
    beforeSnapshots: new Map(),
    earlierTaskWrites: new Map(),
    baseRefs: new Map(),
  };
}

/** 1-task simple plan (status 可调)。 */
function onePlan(status: "pending" | "running" = "pending", attempt = 0): TaskPlan {
  return parseTaskPlan({
    complexity: "simple",
    tasks: [
      {
        id: "T01",
        title: "t",
        allowed_write_paths: ["src/**"],
        acceptance_refs: ["AC-001"],
        status,
        attempt,
        tests: [{ id: "t1", scenario: "happy", checks: ["passed == true"] }],
      },
    ],
  });
}

function implState(activeTasks: string[] = []): RunState {
  return parseRunState({
    run_id: "20260627-001",
    complexity: "simple",
    phase: Phase.IMPLEMENTING,
    active_tasks: activeTasks,
  });
}

function greenOutcome(): WorkerOutcome {
  return makeWorkerOutcome({
    status: "completed",
    test_results: { tests_green: true, cases: [{ id: "t1", passed: true, failure_reason: "" }] },
    summary_text: "done",
  });
}

// ---------------------------------------------------------------------------
// 步骤 1: ABORTED 短路 (优先级最高)
// ---------------------------------------------------------------------------

test("[py: tick §3.7-1] ABORTED phase → 立即短路, 不调度", () => {
  const state = parseRunState({
    run_id: "20260627-001",
    complexity: "simple",
    phase: Phase.ABORTED,
    aborted_at: "2026-06-27T12:00:00+00:00",
    aborted_reason: "test",
  });
  const plan = onePlan("pending");
  const runner = new RecordingWorkerRunner([greenOutcome()]);
  const [, , result] = tick(state, plan, runner, freshRuntime(), { now: new Date() });

  expect(result.aborted_check).toBe(true);
  expect(result.dispatched).toEqual([]);
  expect(result.ready_selected).toEqual([]);
  // runner 未被调用。
  expect(runner.dispatchedPackets.length).toBe(0);
});

// ---------------------------------------------------------------------------
// 步骤 4: readyFrontier 派发 (仅 IMPLEMENTING)
// ---------------------------------------------------------------------------

test("[py: tick §3.7-4] IMPLEMENTING + pending task → 选中 + 翻 running + 派发 + 自检通过转 complete", () => {
  const runDir = makeTmpRunDir();
  const runner = new RecordingWorkerRunner([greenOutcome()]);
  const [newState, newPlan, result] = tick(
    implState(),
    onePlan("pending"),
    runner,
    freshRuntime(),
    { now: new Date(), runDir },
  );

  expect(result.ready_selected).toEqual(["T01"]);
  expect(result.dispatched).toEqual(["T01"]);
  // 阻塞派发 → 当 tick 内自检通过 → complete。
  expect(newPlan.tasks[0]!.status).toBe("complete");
  expect(newState.active_tasks).toEqual([]);
  expect(result.completed_results.length).toBe(1);
  expect(runner.dispatchedPackets[0]!.task_id).toBe("T01");
});

test("[py: tick] 非 IMPLEMENTING phase 不走 readyFrontier 派发", () => {
  const planningState = parseRunState({
    run_id: "20260627-001",
    complexity: "simple",
    phase: Phase.PLANNING,
  });
  const runner = new RecordingWorkerRunner([greenOutcome()]);
  const [, , result] = tick(planningState, onePlan("pending"), runner, freshRuntime(), {
    now: new Date(),
  });
  expect(result.ready_selected).toEqual([]);
  expect(result.dispatched).toEqual([]);
  expect(runner.dispatchedPackets.length).toBe(0);
});

// ---------------------------------------------------------------------------
// 步骤 2: 收回 outcome — 自检不通过 → 留 running (等 fix-once / watchdog)
// ---------------------------------------------------------------------------

test("[py: tick §3.7-2] worker 交回但自检不通过 → 留 running", () => {
  const runDir = makeTmpRunDir();
  const badOutcome = makeWorkerOutcome({
    status: "completed",
    test_results: { tests_green: false, cases: [] },
  });
  const runner = new RecordingWorkerRunner([badOutcome]);
  const rt = freshRuntime();
  const [, newPlan] = tick(implState(), onePlan("pending"), runner, rt, {
    now: new Date(),
    runDir,
  });
  expect(newPlan.tasks[0]!.status).toBe("running");
  expect(rt.startedAtByTask.has("T01")).toBe(true);
});

// ---------------------------------------------------------------------------
// plan_amendment 透传 (tick 自身不回滚)
// ---------------------------------------------------------------------------

test("[py: tick §3.6] worker 返回 plan_amendment → 透传给 caller, tick 不回滚", () => {
  const runDir = makeTmpRunDir();
  const runner = new RecordingWorkerRunner([
    makeWorkerOutcome({
      status: "plan_amendment",
      plan_amendment: {
        status: "plan-amendment-needed",
        reason: "用例不可执行",
        touched_acceptance_refs: ["AC-001"],
      },
    }),
  ]);
  const [, newPlan, result] = tick(implState(), onePlan("pending"), runner, freshRuntime(), {
    now: new Date(),
    runDir,
  });
  expect(result.plan_amendments.length).toBe(1);
  // tick 自身不回滚: T01 派发后翻 running, 收到 amendment 不转 complete 也不回 pending。
  expect(newPlan.tasks[0]!.status).toBe("running");
});

// ---------------------------------------------------------------------------
// 步骤 3: watchdog recycle (固定顺序: watchdog 在 readyFrontier 之前)
// ---------------------------------------------------------------------------

test("[py: test_watchdog_recycle_after_timeout] running 超时 → recycle, attempt+1 + stale+1 + watchdog.json", () => {
  const runDir = makeTmpRunDir();
  // 预置: T01 已 running, started_at 30 分钟前 (simple 档默认 15 min 超时)。
  const rt = freshRuntime();
  const now = new Date(Date.UTC(2026, 5, 27, 12, 0, 0));
  rt.startedAtByTask.set("T01", new Date(now.getTime() - 30 * 60 * 1000));

  // 第二个 outcome: recycle 后同 tick 内 readyFrontier 重派会消费 (bad → 留 running)。
  const badOutcome = makeWorkerOutcome({
    status: "completed",
    test_results: { tests_green: false, cases: [] },
  });
  const runner = new RecordingWorkerRunner([badOutcome]);

  const [, newPlan, result] = tick(
    implState(["T01"]),
    onePlan("running"),
    runner,
    rt,
    { now, runDir },
  );

  // watchdog 决策含 recycle_to_pending。
  expect(result.watchdog_actions.some((d) => d.action === "recycle_to_pending")).toBe(true);
  // attempt +1。
  expect(newPlan.tasks[0]!.attempt).toBe(1);
  // stale_count +1。
  expect(rt.staleCountByTask.get("T01")).toBe(1);
  // watchdog.json 含 timeout 事件。
  const wdPath = path.join(runDir, "tasks", "T01", "logs", "watchdog.json");
  expect(fs.existsSync(wdPath)).toBe(true);
  const events = JSON.parse(fs.readFileSync(wdPath, "utf-8")) as Array<{ reason: string }>;
  expect(events.some((e) => e.reason === "timeout")).toBe(true);
});

// ---------------------------------------------------------------------------
// directory: 原子写 + exclude_none + atomicReplace 重试
// ---------------------------------------------------------------------------

test("[py: directory.writeRunState] run-state.json 原子写, exclude_none 剔除 null 字段", () => {
  const runDir = makeTmpRunDir();
  const state = parseRunState({ run_id: "20260627-001", complexity: "simple", phase: Phase.CREATED });
  writeRunState(runDir, state);

  const raw = fs.readFileSync(path.join(runDir, "run-state.json"), "utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  // human_pending=null / aborted_at=null 不应出现 (exclude_none)。
  expect("human_pending" in parsed).toBe(false);
  expect("aborted_at" in parsed).toBe(false);
  expect("aborted_reason" in parsed).toBe(false);
  // 核心字段在。
  expect(parsed.run_id).toBe("20260627-001");
  expect(parsed.phase).toBe("CREATED");

  // 可被 readRunState 读回。
  const back = readRunState(runDir);
  expect(back.phase).toBe(Phase.CREATED);
});

test("[py: directory._atomic_replace 重试] rename 前几次失败 → 重试后成功 (注入 renameFn)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-atomic-"));
  const src = path.join(dir, "src.tmp");
  const dst = path.join(dir, "dst.json");
  fs.writeFileSync(src, "payload", "utf-8");

  // 注入桩: 前 2 次抛 EPERM, 第 3 次真正 rename。
  let calls = 0;
  const renameFn = (s: string, d: string): void => {
    calls += 1;
    if (calls < 3) {
      const err = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    }
    fs.renameSync(s, d);
  };
  atomicReplace(src, dst, 5, 1, renameFn);

  expect(calls).toBe(3);
  expect(fs.existsSync(dst)).toBe(true);
  expect(fs.readFileSync(dst, "utf-8")).toBe("payload");
});

test("[py: directory._atomic_replace 重试] 全部失败 → 抛最后一次错误 (注入 renameFn)", () => {
  let calls = 0;
  const renameFn = (): void => {
    calls += 1;
    const err = new Error("EBUSY") as NodeJS.ErrnoException;
    err.code = "EBUSY";
    throw err;
  };
  expect(() => atomicReplace("a", "b", 3, 1, renameFn)).toThrow("EBUSY");
  // 重试 3 次后才抛。
  expect(calls).toBe(3);
});
