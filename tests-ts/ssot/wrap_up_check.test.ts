/**
 * §2.3 收口自检等价测试 (P4-M4, design §2.3 + §11.3 集成自检)。
 *
 * 行为权威: Python `tests/test_wrap_up_check.py` + `loop_engineering/checklists/wrap_up_check.py`。
 * 被测实现: `packages/ssot-ts/src/checklists/wrap_up_check.ts`。
 *
 * 覆盖: all_tasks_tests_green (pass/某 task fail)、key_diffs_md_ready (有提交/无提交)、
 * all_hard_gates_pass (high-risk 有 key-diffs pass / 缺 fail)、scope_consistent (一致 pass /
 * 膨胀 fail)、integration_tests_green (none 跳过 / 全绿 pass / 部分红 fail / required 缺 fail)。
 */
import { test, expect, describe } from "bun:test";

import { checkWrapUp } from "../../packages/ssot-ts/src/checklists/wrap_up_check.js";
import type { TaskCheckResult } from "../../packages/ssot-ts/src/checklists/task_check.js";
import { KeyDiffsFileSchema } from "../../packages/ssot-ts/src/schema/artifacts.js";
import type { KeyDiffsFile } from "../../packages/ssot-ts/src/schema/artifacts.js";
import { Complexity } from "../../packages/ssot-ts/src/schema/run_state.js";
import { RiskLevel, TaskSchema, TaskPlanSchema } from "../../packages/ssot-ts/src/schema/task_plan.js";
import type { Task, TaskPlan } from "../../packages/ssot-ts/src/schema/task_plan.js";

function mkTask(
  tid: string,
  opts?: { risk?: RiskLevel; exclusive?: boolean },
): Task {
  return TaskSchema.parse({
    id: tid,
    title: tid,
    allowed_write_paths: [`src/${tid}/**`],
    acceptance_refs: [`AC-${tid}`],
    risk: opts?.risk ?? RiskLevel.normal,
    exclusive: opts?.exclusive ?? false,
  });
}

function mkPlan(tasks: Task[]): TaskPlan {
  return TaskPlanSchema.parse({ complexity: Complexity.simple, tasks });
}

function mkTaskResult(tid: string, allPass: boolean): TaskCheckResult {
  return {
    task_id: tid,
    items: [{ check: "tests_green", passed: allPass, detail: "" }],
    all_pass: allPass,
  };
}

function mkKeyDiffs(tid: string, nonEmpty = true): KeyDiffsFile {
  return KeyDiffsFileSchema.parse({
    task_id: tid,
    key_diffs: nonEmpty
      ? [{ file: "src/x.py", change: "c", why: "w", risk: "low" }]
      : [],
  });
}

// ---------------------------------------------------------------------------
// all_tasks_tests_green
// ---------------------------------------------------------------------------

describe("TestAllTasksGreen", () => {
  test("[py: test_pass]", () => {
    const plan = mkPlan([mkTask("T01"), mkTask("T02")]);
    const taskResults: Record<string, TaskCheckResult> = {
      T01: mkTaskResult("T01", true),
      T02: mkTaskResult("T02", true),
    };
    const kd: Record<string, KeyDiffsFile> = {
      T01: mkKeyDiffs("T01"),
      T02: mkKeyDiffs("T02"),
    };
    const result = checkWrapUp(plan, taskResults, kd);
    const items = result.items.filter((i) => i.check === "all_tasks_tests_green");
    expect(items.length > 0 && items[0]!.passed).toBe(true);
  });

  test("[py: test_fail]", () => {
    const plan = mkPlan([mkTask("T01"), mkTask("T02")]);
    const taskResults: Record<string, TaskCheckResult> = {
      T01: mkTaskResult("T01", true),
      T02: mkTaskResult("T02", false),
    };
    const kd: Record<string, KeyDiffsFile> = {
      T01: mkKeyDiffs("T01"),
      T02: mkKeyDiffs("T02"),
    };
    const result = checkWrapUp(plan, taskResults, kd);
    const items = result.items.filter((i) => i.check === "all_tasks_tests_green");
    expect(items.length > 0 && !items[0]!.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// key_diffs_md_ready
// ---------------------------------------------------------------------------

describe("TestKeyDiffsMdReady", () => {
  test("[py: test_pass]", () => {
    const plan = mkPlan([mkTask("T01")]);
    const result = checkWrapUp(
      plan,
      { T01: mkTaskResult("T01", true) },
      { T01: mkKeyDiffs("T01") },
    );
    const items = result.items.filter((i) => i.check === "key_diffs_md_ready");
    expect(items.length > 0 && items[0]!.passed).toBe(true);
  });

  test("[py: test_fail_when_no_submissions]", () => {
    const plan = mkPlan([mkTask("T01")]);
    const result = checkWrapUp(
      plan,
      { T01: mkTaskResult("T01", true) },
      { T01: null },
    );
    const items = result.items.filter((i) => i.check === "key_diffs_md_ready");
    expect(items.length > 0 && !items[0]!.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// all_hard_gates_pass
// ---------------------------------------------------------------------------

describe("TestHardGates", () => {
  test("[py: test_hard_gate_pass]", () => {
    const plan = mkPlan([mkTask("T01", { risk: RiskLevel.high })]);
    const result = checkWrapUp(
      plan,
      { T01: mkTaskResult("T01", true) },
      { T01: mkKeyDiffs("T01", true) },
    );
    const items = result.items.filter((i) => i.check === "all_hard_gates_pass");
    expect(items.length > 0 && items[0]!.passed).toBe(true);
  });

  test("[py: test_hard_gate_fail_when_high_risk_missing]", () => {
    const plan = mkPlan([mkTask("T01", { risk: RiskLevel.high })]);
    const result = checkWrapUp(
      plan,
      { T01: mkTaskResult("T01", true) },
      { T01: null },
    );
    const items = result.items.filter((i) => i.check === "all_hard_gates_pass");
    expect(items.length > 0 && !items[0]!.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// scope_consistent
// ---------------------------------------------------------------------------

describe("TestScopeConsistent", () => {
  test("[py: test_pass]", () => {
    const plan = mkPlan([mkTask("T01")]);
    const result = checkWrapUp(
      plan,
      { T01: mkTaskResult("T01", true) },
      { T01: mkKeyDiffs("T01") },
      {
        plannedScopeFiles: ["src/T01/a.py"],
        actualScopeFiles: ["src/T01/a.py"],
      },
    );
    const items = result.items.filter((i) => i.check === "scope_consistent");
    expect(items.length > 0 && items[0]!.passed).toBe(true);
  });

  test("[py: test_fail_on_bloat]", () => {
    const plan = mkPlan([mkTask("T01")]);
    const planned = ["src/T01/a.py"];
    // 大量计划外文件
    const actual = [...planned, ...Array.from({ length: 20 }, (_, i) => `src/extra/${i}.py`)];
    const result = checkWrapUp(
      plan,
      { T01: mkTaskResult("T01", true) },
      { T01: mkKeyDiffs("T01") },
      { plannedScopeFiles: planned, actualScopeFiles: actual },
    );
    const items = result.items.filter((i) => i.check === "scope_consistent");
    expect(items.length > 0 && !items[0]!.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// integration_tests_green
// ---------------------------------------------------------------------------

describe("TestIntegrationTests", () => {
  test("[py: test_skipped_when_none]", () => {
    const plan = mkPlan([mkTask("T01")]);
    const result = checkWrapUp(
      plan,
      { T01: mkTaskResult("T01", true) },
      { T01: mkKeyDiffs("T01") },
      { integrationResults: null },
    );
    const items = result.items.filter((i) => i.check === "integration_tests_green");
    expect(items.length > 0 && items[0]!.passed).toBe(true);
    expect(items[0]!.detail).toContain("跳过");
  });

  test("[py: test_pass_when_all_green]", () => {
    const plan = mkPlan([mkTask("T01")]);
    const result = checkWrapUp(
      plan,
      { T01: mkTaskResult("T01", true) },
      { T01: mkKeyDiffs("T01") },
      { integrationResults: { ic1: true, ic2: true } },
    );
    const items = result.items.filter((i) => i.check === "integration_tests_green");
    expect(items.length > 0 && items[0]!.passed).toBe(true);
  });

  test("[py: test_fail_when_some_red]", () => {
    const plan = mkPlan([mkTask("T01")]);
    const result = checkWrapUp(
      plan,
      { T01: mkTaskResult("T01", true) },
      { T01: mkKeyDiffs("T01") },
      { integrationResults: { ic1: true, ic2: false } },
    );
    const items = result.items.filter((i) => i.check === "integration_tests_green");
    expect(items.length > 0 && !items[0]!.passed).toBe(true);
  });
});

test("[py: test_required_integration_fails_when_missing] required 缺 integration 必须 fail", () => {
  const plan = mkPlan([mkTask("T01")]);
  const result = checkWrapUp(
    plan,
    { T01: mkTaskResult("T01", true) },
    { T01: mkKeyDiffs("T01") },
    { integrationResults: null, requiresIntegration: true },
  );
  const items = result.items.filter((i) => i.check === "integration_tests_green");
  expect(items.length > 0 && !items[0]!.passed).toBe(true);
  expect(items[0]!.detail).toContain("不可跳过");
});
