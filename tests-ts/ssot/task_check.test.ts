/**
 * §2.2 任务自检等价测试 (P4-M4, design §2.2 + §0.2 tests_green 用 eval_result)。
 *
 * 行为权威: Python `tests/test_task_check.py` + `loop_engineering/checklists/task_check.py`。
 * 被测实现: `packages/ssot-ts/src/checklists/task_check.ts`。
 *
 * 覆盖: tests_green (绿/红, 关键: 用 eval_result 而非 worker 自报)、diff_within_allowed_paths
 * (oob pass/越界 fail/oob=null 软约束)、all_acceptance_refs_have_tests (有/无 test)、
 * no_encroaching_other_active_paths (无 active / 重叠 fail, 注入 + 缺省 pathGlobsOverlap)。
 *
 * 说明: Python 用 CaseEvalResult/CheckEvalResult/Check 构造 TaskCheckEvalResult;
 * TS 侧 TaskCheckEvalResult 的 tests_green 是普通字段 (工厂派生, 见 checks_eval.ts),
 * 本测试直接构造同形对象, 只需 tests_green 取目标值 (task_check 只读 tests_green / task_id)。
 */
import { test, expect, describe } from "bun:test";

import { checkTask } from "../../packages/ssot-ts/src/checklists/task_check.js";
import type { OOBDetection } from "../../packages/ssot-ts/src/checklists/task_check.js";
import type {
  CaseEvalResult,
  TaskCheckEvalResult,
} from "../../packages/ssot-ts/src/checklists/checks_eval.js";
import { Op } from "../../packages/ssot-ts/src/checklists/checks_eval.js";
import { pathGlobsOverlap } from "../../packages/ssot-ts/src/scheduling/path_overlap.js";
import { TestResultsSchema } from "../../packages/ssot-ts/src/schema/artifacts.js";
import type { TestResults } from "../../packages/ssot-ts/src/schema/artifacts.js";
import { TaskSchema } from "../../packages/ssot-ts/src/schema/task_plan.js";
import type { Task } from "../../packages/ssot-ts/src/schema/task_plan.js";

function mkEvalResult(taskId: string, green: boolean): TaskCheckEvalResult {
  const caseResult: CaseEvalResult = {
    case_id: "c1",
    check_results: [
      {
        check: { raw: "passed == true", lhs: "passed", op: Op.EQ, rhs: true },
        passed: green,
        error: green ? null : "mismatch",
      },
    ],
    passed: green,
  };
  return {
    task_id: taskId,
    case_results: [caseResult],
    warnings: [],
    tests_green: green,
  };
}

function mkTestResults(green: boolean): TestResults {
  return TestResultsSchema.parse({
    tests_green: green,
    cases: [{ id: "c1", passed: green }],
  });
}

function mkTask(
  tid = "T01",
  opts?: { refs?: string[]; paths?: string[]; tests?: number },
): Task {
  const tests = opts?.tests ?? 1;
  return TaskSchema.parse({
    id: tid,
    title: tid,
    allowed_write_paths: opts?.paths ?? ["src/T01/**"],
    acceptance_refs: opts?.refs ?? ["AC-1"],
    tests: Array.from({ length: tests }, (_, i) => ({
      id: `c${i}`,
      scenario: "s",
      checks: ["passed == true"],
    })),
  });
}

// ---------------------------------------------------------------------------
// tests_green
// ---------------------------------------------------------------------------

describe("TestTestsGreen", () => {
  test("[py: test_green_passes]", () => {
    const t = mkTask();
    const result = checkTask(t, mkTestResults(true), mkEvalResult("T01", true));
    const items = result.items.filter((i) => i.check === "tests_green");
    expect(items.length > 0 && items[0]!.passed).toBe(true);
  });

  test("[py: test_red_fails]", () => {
    const t = mkTask();
    const result = checkTask(t, mkTestResults(true), mkEvalResult("T01", false));
    const items = result.items.filter((i) => i.check === "tests_green");
    expect(items.length > 0 && !items[0]!.passed).toBe(true);
  });

  test("[py: test_uses_eval_result_not_worker_tests_green]", () => {
    // 关键: worker 自报 tests_green=true, 但 eval_result.tests_green=false -> 项 fail
    const t = mkTask();
    const result = checkTask(t, mkTestResults(true), mkEvalResult("T01", false));
    const items = result.items.filter((i) => i.check === "tests_green");
    expect(items.length > 0 && !items[0]!.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// diff_within_allowed_paths
// ---------------------------------------------------------------------------

describe("TestOOB", () => {
  test("[py: test_oob_pass]", () => {
    const t = mkTask("T01", { paths: ["src/T01/**"] });
    const oob: OOBDetection = {
      task_id: "T01",
      declared_paths: ["src/T01/**"],
      actual_writes: ["src/T01/a.py"],
      out_of_bounds: [],
      is_oob: false,
    };
    const result = checkTask(t, mkTestResults(true), mkEvalResult("T01", true), { oob });
    const items = result.items.filter((i) => i.check === "diff_within_allowed_paths");
    expect(items.length > 0 && items[0]!.passed).toBe(true);
  });

  test("[py: test_oob_fails_when_extra_path]", () => {
    const t = mkTask("T01", { paths: ["src/T01/**"] });
    const oob: OOBDetection = {
      task_id: "T01",
      declared_paths: ["src/T01/**"],
      actual_writes: ["src/T01/a.py", "src/OTHER/b.py"],
      out_of_bounds: ["src/OTHER/b.py"],
      is_oob: true,
    };
    const result = checkTask(t, mkTestResults(true), mkEvalResult("T01", true), { oob });
    const items = result.items.filter((i) => i.check === "diff_within_allowed_paths");
    expect(items.length > 0 && !items[0]!.passed).toBe(true);
  });

  test("[py: test_oob_soft_when_unavailable]", () => {
    // oob=null -> soft pass with detail
    const t = mkTask();
    const result = checkTask(t, mkTestResults(true), mkEvalResult("T01", true), {
      oob: null,
    });
    const items = result.items.filter((i) => i.check === "diff_within_allowed_paths");
    expect(items.length > 0 && items[0]!.passed).toBe(true);
    expect(items[0]!.detail).toContain("软约束");
  });
});

// ---------------------------------------------------------------------------
// all_acceptance_refs_have_tests
// ---------------------------------------------------------------------------

describe("TestAcceptanceRefs", () => {
  test("[py: test_refs_have_tests_pass]", () => {
    const t = mkTask("T01", { refs: ["AC-1"], tests: 1 });
    const result = checkTask(t, mkTestResults(true), mkEvalResult("T01", true));
    const items = result.items.filter((i) => i.check === "all_acceptance_refs_have_tests");
    expect(items.length > 0 && items[0]!.passed).toBe(true);
  });

  test("[py: test_refs_have_tests_fail_when_no_tests]", () => {
    const t = mkTask("T01", { refs: ["AC-1"], tests: 0 });
    const result = checkTask(t, mkTestResults(true), mkEvalResult("T01", true));
    const items = result.items.filter((i) => i.check === "all_acceptance_refs_have_tests");
    expect(items.length > 0 && !items[0]!.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// no_encroaching_other_active_paths
// ---------------------------------------------------------------------------

describe("TestNoEncroachingActivePaths", () => {
  test("[py: test_no_active_tasks_pass]", () => {
    const t = mkTask();
    const result = checkTask(t, mkTestResults(true), mkEvalResult("T01", true), {
      activeTasks: null,
      pathOverlapFn: pathGlobsOverlap,
    });
    const items = result.items.filter(
      (i) => i.check === "no_encroaching_other_active_paths",
    );
    expect(items.length > 0 && items[0]!.passed).toBe(true);
  });

  test("[py: test_encroaching_other_active_fails]", () => {
    const t = mkTask("T01", { paths: ["src/shared/**"] });
    const other = mkTask("T02", { paths: ["src/shared/**"] });
    const result = checkTask(t, mkTestResults(true), mkEvalResult("T01", true), {
      activeTasks: [other],
      pathOverlapFn: pathGlobsOverlap,
    });
    const items = result.items.filter(
      (i) => i.check === "no_encroaching_other_active_paths",
    );
    expect(items.length > 0 && !items[0]!.passed).toBe(true);
  });
});

test("[py: test_default_path_overlap_detects_active_conflict] 缺省 pathOverlapFn 检出 active 冲突", () => {
  const t = mkTask("T01", { paths: ["src/shared/**"] });
  const other = mkTask("T02", { paths: ["src/shared/**"] });
  const result = checkTask(t, mkTestResults(true), mkEvalResult("T01", true), {
    activeTasks: [other],
  });
  const items = result.items.filter(
    (i) => i.check === "no_encroaching_other_active_paths",
  );
  expect(items.length > 0 && !items[0]!.passed).toBe(true);
});
