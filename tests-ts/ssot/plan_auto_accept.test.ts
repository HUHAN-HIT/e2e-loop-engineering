/**
 * shouldAutoAcceptPlan 真值表 (spec 2026-07-01)。
 * 免签 ⟺ simple ∧ !requirePlanSignoff ∧ 无 risk:high ∧ 无 exclusive ∧ 无契约。
 */
import { test, expect } from "bun:test";
import { shouldAutoAcceptPlan } from "../../packages/ssot-ts/src/state_machine/plan_auto_accept.js";
import { parseTaskPlan } from "../../packages/ssot-ts/src/schema/task_plan.js";
import type { Task } from "../../packages/ssot-ts/src/schema/task_plan.js";

/** 造 task 列表: 默认 1 个 normal/非 exclusive task。 */
function tasks(opts?: { riskHigh?: boolean; exclusive?: boolean }): Task[] {
  return parseTaskPlan({
    complexity: "simple",
    tasks: [
      {
        id: "T01",
        title: "t",
        allowed_write_paths: ["src/**"],
        acceptance_refs: ["AC-001"],
        risk: opts?.riskHigh ? "high" : "normal",
        exclusive: opts?.exclusive ?? false,
      },
    ],
  }).tasks;
}

test("simple + 无风险闸 + config=false → 免签 true", () => {
  expect(
    shouldAutoAcceptPlan({
      complexity: "simple",
      tasks: tasks(),
      requirePlanSignoff: false,
      hasServiceContracts: false,
    }),
  ).toBe(true);
});

test("medium / complex → 不免签", () => {
  for (const c of ["medium", "complex"] as const) {
    expect(
      shouldAutoAcceptPlan({
        complexity: c,
        tasks: tasks(),
        requirePlanSignoff: false,
        hasServiceContracts: false,
      }),
    ).toBe(false);
  }
});

test("simple + require_plan_signoff=true → 不免签 (opt-out 开关)", () => {
  expect(
    shouldAutoAcceptPlan({
      complexity: "simple",
      tasks: tasks(),
      requirePlanSignoff: true,
      hasServiceContracts: false,
    }),
  ).toBe(false);
});

test("simple + risk:high task → 不免签 (风险闸①)", () => {
  expect(
    shouldAutoAcceptPlan({
      complexity: "simple",
      tasks: tasks({ riskHigh: true }),
      requirePlanSignoff: false,
      hasServiceContracts: false,
    }),
  ).toBe(false);
});

test("simple + exclusive task → 不免签 (风险闸②)", () => {
  expect(
    shouldAutoAcceptPlan({
      complexity: "simple",
      tasks: tasks({ exclusive: true }),
      requirePlanSignoff: false,
      hasServiceContracts: false,
    }),
  ).toBe(false);
});

test("simple + 存在 service-contracts → 不免签 (风险闸③)", () => {
  expect(
    shouldAutoAcceptPlan({
      complexity: "simple",
      tasks: tasks(),
      requirePlanSignoff: false,
      hasServiceContracts: true,
    }),
  ).toBe(false);
});
