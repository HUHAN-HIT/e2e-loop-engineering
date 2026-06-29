import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildNavigationMap,
  initRunDir,
  writeRunState,
  writeTaskPlan,
} from "../../packages/ssot-ts/src/runtime/index.js";
import { HumanPending, Phase, parseRunState } from "../../packages/ssot-ts/src/schema/run_state.js";
import { parseTaskPlan } from "../../packages/ssot-ts/src/schema/task_plan.js";

function makeRun(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loop-nav-"));
  const runDir = initRunDir(path.join(root, "runs"), "20260628-001", "req");
  writeRunState(
    runDir,
    parseRunState({ run_id: "20260628-001", complexity: "simple", phase: Phase.CREATED }),
  );
  return runDir;
}

test("navigation map treats human signoff as normal pending, not a blocker", () => {
  const runDir = makeRun();
  const state = parseRunState({
    run_id: "20260628-001",
    complexity: "simple",
    phase: Phase.PLANNING,
    human_pending: HumanPending.plan_signoff,
  });

  const map = buildNavigationMap(runDir, state, null);

  expect(map.current_phase).toBe(Phase.PLANNING);
  // 人盯锚点是 run 的正常停顿 (design 人盯点), 不是失败 → 不进 blocker, 单列 human_pending。
  expect(map.human_pending).toBe("plan_signoff");
  expect(map.blocker).toBeNull();
  expect(map.next_action).toBe("review the plan, then run signoff-plan or reject with feedback");
  // 等人签字时当前 phase 仍是 current (正常进行中), 不是 blocked。
  expect(map.phases.find((p) => p.phase === Phase.PLANNING)?.status).toBe("current");
});

test("navigation map points to plan-check-failures.json", () => {
  const runDir = makeRun();
  const failurePath = path.join(runDir, "planning", "plan-check-failures.json");
  fs.mkdirSync(path.dirname(failurePath), { recursive: true });
  fs.writeFileSync(
    failurePath,
    JSON.stringify([{ check: "ac_has_task_and_test", passed: false, detail: "AC-001 has no tests" }]),
    "utf-8",
  );
  const state = parseRunState({
    run_id: "20260628-001",
    complexity: "simple",
    phase: Phase.PLANNING,
  });

  const map = buildNavigationMap(runDir, state, null);

  expect(map.blocker?.kind).toBe("plan_check_failed");
  expect(map.blocker?.evidence_paths).toEqual(["planning/plan-check-failures.json"]);
  expect(map.next_action).toBe("fix planning/task-plan.yaml and rerun plan");
});

test("navigation map flags a running task that wrote collect-failures.json", () => {
  // 真实失败路径 (主 agent 的 dispatch + collect-outcome): 自检失败时 task 留 running、
  // 写 collect-failures.json, 不会翻 blocked (blocked 仅 tick watchdog 路径产生)。
  // 这是导航图必须能看见的最常见失败 —— 不能因为 task 仍是 running 就漏报。
  const runDir = makeRun();
  const plan = parseTaskPlan({
    complexity: "simple",
    tasks: [
      {
        id: "T01",
        title: "failing task",
        allowed_write_paths: ["src/**"],
        acceptance_refs: ["AC-001"],
        tests: [{ id: "case1", scenario: "happy path", checks: ["passed == true"] }],
        status: "running",
        attempt: 1,
      },
      {
        id: "T02",
        title: "pending task",
        allowed_write_paths: ["docs/**"],
        acceptance_refs: ["AC-002"],
        tests: [{ id: "case2", scenario: "docs path", checks: ["passed == true"] }],
        status: "pending",
        attempt: 0,
      },
    ],
  });
  writeTaskPlan(path.join(runDir, "planning", "task-plan.yaml"), plan);
  const failurePath = path.join(runDir, "tasks", "T01", "collect-failures.json");
  fs.mkdirSync(path.dirname(failurePath), { recursive: true });
  fs.writeFileSync(
    failurePath,
    JSON.stringify({
      task_id: "T01",
      reason: "task_check_fail",
      failures: [{ check: "tests_green", passed: false, detail: "tests failed" }],
      oob_paths: [],
      attempt: 1,
      collected_at: "2026-06-28T00:00:00.000Z",
    }),
    "utf-8",
  );
  const state = parseRunState({
    run_id: "20260628-001",
    complexity: "simple",
    phase: Phase.IMPLEMENTING,
    active_tasks: ["T01"],
  });

  const map = buildNavigationMap(runDir, state, plan);

  expect(map.task_summary).toEqual({
    pending: 1,
    running: 1,
    blocked: 0,
    complete: 0,
  });
  expect(map.blocker?.kind).toBe("task_failed");
  expect(map.blocker?.evidence_paths).toEqual(["tasks/T01/collect-failures.json"]);
  expect(map.next_action).toBe("inspect failed task evidence and dispatch a fix or abort");
});

test("navigation map flags a watchdog-blocked task", () => {
  // watchdog 路径 (dry-run tick 循环): 二次回收后 task 翻 blocked, 证据在 logs/watchdog.json。
  const runDir = makeRun();
  const plan = parseTaskPlan({
    complexity: "simple",
    tasks: [
      {
        id: "T01",
        title: "blocked task",
        allowed_write_paths: ["src/**"],
        acceptance_refs: ["AC-001"],
        tests: [{ id: "case1", scenario: "happy path", checks: ["passed == true"] }],
        status: "blocked",
        attempt: 2,
      },
    ],
  });
  writeTaskPlan(path.join(runDir, "planning", "task-plan.yaml"), plan);
  const wdPath = path.join(runDir, "tasks", "T01", "logs", "watchdog.json");
  fs.mkdirSync(path.dirname(wdPath), { recursive: true });
  // 真实结构: watchdog mark_blocked (max_retries_exhausted) 写 reason="no_response" 的
  // WatchdogEvent {task_id, reason, attempt, timestamp} (见 scheduling/watchdog.ts:40-44/170-178)。
  // 注: "timeout" 是 recycle_to_pending 路径; 翻 blocked 的那条事件是 "no_response"。
  fs.writeFileSync(
    wdPath,
    JSON.stringify([
      {
        task_id: "T01",
        reason: "no_response",
        attempt: 2,
        timestamp: "2026-06-28T00:00:00.000Z",
      },
    ]),
    "utf-8",
  );
  const state = parseRunState({
    run_id: "20260628-001",
    complexity: "simple",
    phase: Phase.IMPLEMENTING,
  });

  const map = buildNavigationMap(runDir, state, plan);

  expect(map.task_summary.blocked).toBe(1);
  expect(map.blocker?.kind).toBe("task_failed");
  expect(map.blocker?.evidence_paths).toEqual(["tasks/T01/logs/watchdog.json"]);
});

test("navigation map flags an aborted run", () => {
  // ABORTED: blocker.kind=aborted; 常规 phase 全 pending; 末尾追加一条 blocked 的 ABORTED phase。
  const runDir = makeRun();
  const state = parseRunState({
    run_id: "20260628-001",
    complexity: "simple",
    phase: Phase.ABORTED,
    // schema superRefine: phase=ABORTED 时 aborted_at 必须非空。
    aborted_at: "2026-06-28T00:00:00.000Z",
    aborted_reason: "人主动放弃 (test)",
  });

  const map = buildNavigationMap(runDir, state, null);

  expect(map.current_phase).toBe(Phase.ABORTED);
  expect(map.blocker?.kind).toBe("aborted");
  expect(map.blocker?.reason).toBe("人主动放弃 (test)");
  expect(map.blocker?.evidence_paths).toEqual(["run-state.json"]);
  expect(map.next_action).toBe("inspect aborted_reason and start a new run if needed");
  // 常规 phase 全部 pending。
  expect(map.phases.find((p) => p.phase === Phase.PLANNING)?.status).toBe("pending");
  // 末尾追加一条 ABORTED phase, status=blocked。
  const abortedPhase = map.phases.find((p) => p.phase === Phase.ABORTED);
  expect(abortedPhase?.status).toBe("blocked");
  expect(abortedPhase?.detail).toBe("人主动放弃 (test)");
});

test("navigation map flags wrap-up gate failure and steers to reject", () => {
  // 收口自检失败: submitWrapUp 不论成败都 set human_pending=wrap_up_signoff, 同时
  // check-result.json 含 passed:false。导航图应报 wrap_up_failed, 且 next_action 优先
  // 引导 reject (而非"去签字") —— 覆盖 nextAction 中 wrap_up_failed 优先于 human_pending 的分支。
  const runDir = makeRun();
  const checkPath = path.join(runDir, "wrap-up", "check-result.json");
  fs.mkdirSync(path.dirname(checkPath), { recursive: true });
  fs.writeFileSync(
    checkPath,
    JSON.stringify([
      { check: "all_tasks_tests_green", passed: true, detail: "" },
      { check: "all_hard_gates_pass", passed: false, detail: "T01 缺 key-diffs" },
    ]),
    "utf-8",
  );
  const state = parseRunState({
    run_id: "20260628-001",
    complexity: "simple",
    phase: Phase.WRAPPING_UP,
    human_pending: HumanPending.wrap_up_signoff,
  });

  const map = buildNavigationMap(runDir, state, null);

  expect(map.blocker?.kind).toBe("wrap_up_failed");
  expect(map.blocker?.evidence_paths).toEqual(["wrap-up/check-result.json"]);
  expect(map.next_action).toBe(
    "reject wrap-up, return to IMPLEMENTING, and repair failing evidence",
  );
});
