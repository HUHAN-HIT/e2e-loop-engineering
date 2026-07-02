/**
 * §2.1 计划自检等价测试 (P4-M4, design §2.1 + §11.2 多服务契约自检)。
 *
 * 行为权威: Python `tests/test_plan_check.py` + `loop_engineering/checklists/plan_check.py`。
 * 被测实现: `packages/ssot-ts/src/checklists/plan_check.ts`。
 *
 * 覆盖: ac_has_task_and_test (pass/无 test fail)、task_has_fields (present/missing)、
 * parallel_paths_disjoint (disjoint/overlap, 注入 + 缺省 pathGlobsOverlap)、deps_no_cycle、
 * 契约检查 (none 跳过 / provider_consumer pass / 缺 consumer fail / 缺显式声明 fail)。
 */
import { test, expect, describe } from "bun:test";

import { checkPlan } from "../../packages/ssot-ts/src/checklists/plan_check.js";
import { pathGlobsOverlap } from "../../packages/ssot-ts/src/scheduling/path_overlap.js";
import { parseClarificationQuestions } from "../../packages/ssot-ts/src/schema/clarification.js";
import {
  ServiceContractsSchema,
} from "../../packages/ssot-ts/src/schema/service_contracts.js";
import type { ServiceContracts } from "../../packages/ssot-ts/src/schema/service_contracts.js";
import { Complexity } from "../../packages/ssot-ts/src/schema/run_state.js";
import { TaskSchema, TaskPlanSchema } from "../../packages/ssot-ts/src/schema/task_plan.js";
import type { Task, TaskPlan } from "../../packages/ssot-ts/src/schema/task_plan.js";
import { parseTaskDetail } from "../../packages/ssot-ts/src/schema/task_detail.js";

function mkTask(
  tid: string,
  opts?: {
    refs?: string[];
    paths?: string[];
    dependsOn?: string[];
    tests?: number;
    service?: string | null;
    provides?: string[];
    consumes?: string[];
    exclusive?: boolean;
    risk?: "normal" | "high";
    detailRef?: string | null;
  },
): Task {
  const tests = opts?.tests ?? 1;
  return TaskSchema.parse({
    id: tid,
    title: tid,
    allowed_write_paths: opts?.paths ?? [`src/${tid}/**`],
    acceptance_refs: opts?.refs ?? [`AC-${tid}`],
    depends_on: opts?.dependsOn ?? [],
    tests: Array.from({ length: tests }, () => ({
      id: `c-${tid}`,
      scenario: "s",
      checks: ["passed == true"],
    })),
    service: opts?.service ?? null,
    provides_contracts: opts?.provides ?? [],
    consumes_contracts: opts?.consumes ?? [],
    exclusive: opts?.exclusive ?? false,
    risk: opts?.risk ?? "normal",
    detail_ref: opts?.detailRef ?? null,
  });
}

function mkPlan(tasks: Task[], complexity: Complexity = Complexity.simple): TaskPlan {
  return TaskPlanSchema.parse({ complexity, tasks });
}

// ---------------------------------------------------------------------------
// ac_has_task_and_test
// ---------------------------------------------------------------------------

describe("TestAcHasTaskAndTest", () => {
  test("[py: test_ac_mapping_pass]", () => {
    const plan = mkPlan([mkTask("T01", { refs: ["AC-1"], tests: 1 })]);
    const result = checkPlan(plan);
    const acItems = result.items.filter((i) => i.check === "ac_has_task_and_test");
    expect(acItems.length > 0 && acItems.every((i) => i.passed)).toBe(true);
  });

  test("[py: test_ac_mapping_fail_when_task_has_no_tests]", () => {
    const plan = mkPlan([mkTask("T01", { refs: ["AC-1"], tests: 0 })]);
    const result = checkPlan(plan);
    const acItems = result.items.filter((i) => i.check === "ac_has_task_and_test");
    expect(acItems.some((i) => !i.passed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// task_has_fields
// ---------------------------------------------------------------------------

describe("TestRequiredFields", () => {
  test("[py: test_required_fields_present]", () => {
    const plan = mkPlan([mkTask("T01")]);
    const result = checkPlan(plan);
    const fieldItems = result.items.filter((i) => i.check === "task_has_fields");
    expect(fieldItems.every((i) => i.passed)).toBe(true);
  });

  test("[py: test_required_fields_missing_fails]", () => {
    // 缺 acceptance_refs 与 allowed_write_paths
    const bad = TaskSchema.parse({
      id: "T01",
      title: "t",
      allowed_write_paths: [],
      acceptance_refs: [],
    });
    const plan = mkPlan([bad]);
    const result = checkPlan(plan);
    const fieldItems = result.items.filter((i) => i.check === "task_has_fields");
    expect(fieldItems.some((i) => !i.passed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parallel_paths_disjoint
// ---------------------------------------------------------------------------

describe("TestParallelPathsDisjoint", () => {
  test("[py: test_disjoint_pass]", () => {
    const plan = mkPlan([
      mkTask("T01", { paths: ["src/a/**"] }),
      mkTask("T02", { paths: ["src/b/**"] }),
    ]);
    const result = checkPlan(plan, { pathOverlapFn: pathGlobsOverlap });
    const items = result.items.filter((i) => i.check === "parallel_paths_disjoint");
    expect(items.every((i) => i.passed)).toBe(true);
  });

  test("[py: test_disjoint_fail_when_overlap]", () => {
    const plan = mkPlan([
      mkTask("T01", { paths: ["src/shared/**"] }),
      mkTask("T02", { paths: ["src/shared/**"] }),
    ]);
    const result = checkPlan(plan, { pathOverlapFn: pathGlobsOverlap });
    const items = result.items.filter((i) => i.check === "parallel_paths_disjoint");
    expect(items.some((i) => !i.passed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deps_no_cycle
// ---------------------------------------------------------------------------

describe("TestDepsNoCycle", () => {
  test("[py: test_no_cycle_pass]", () => {
    const plan = mkPlan([
      mkTask("T01", { dependsOn: [] }),
      mkTask("T02", { dependsOn: ["T01"] }),
    ]);
    const result = checkPlan(plan);
    const items = result.items.filter((i) => i.check === "deps_no_cycle");
    expect(items.length > 0 && items.every((i) => i.passed)).toBe(true);
  });

  test("[py: test_cycle_detected]", () => {
    const plan = mkPlan([
      mkTask("T01", { dependsOn: ["T02"] }),
      mkTask("T02", { dependsOn: ["T01"] }),
    ]);
    const result = checkPlan(plan);
    const items = result.items.filter((i) => i.check === "deps_no_cycle");
    expect(items.length > 0 && !items[0]!.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 契约检查 (§11.2)
// ---------------------------------------------------------------------------

describe("TestContractsCheck", () => {
  test("[py: test_contracts_check_skipped_when_none]", () => {
    const plan = mkPlan([mkTask("T01")]);
    const result = checkPlan(plan, { contracts: null });
    // 不应有契约相关检查项
    expect(result.items.some((i) => i.check.includes("contract"))).toBe(false);
  });

  test("[py: test_contracts_have_provider_consumer_pass]", () => {
    const contracts: ServiceContracts = ServiceContractsSchema.parse({
      contracts: [
        {
          id: "C-auth",
          provider: "auth",
          consumers: ["gateway"],
          surface: "token",
          integration_cases: ["ic1"],
        },
      ],
    });
    const plan = mkPlan([
      mkTask("T01", { service: "auth", provides: ["C-auth"] }),
      mkTask("T02", { service: "gateway", consumes: ["C-auth"] }),
    ]);
    const result = checkPlan(plan, { contracts });
    const items = result.items.filter(
      (i) => i.check === "contract_provider_consumer_have_tasks",
    );
    expect(items.length > 0 && items.every((i) => i.passed)).toBe(true);
  });

  test("[py: test_contracts_missing_consumer_task_fails]", () => {
    const contracts: ServiceContracts = ServiceContractsSchema.parse({
      contracts: [
        {
          id: "C-auth",
          provider: "auth",
          consumers: ["gateway", "billing"],
          surface: "token",
          integration_cases: ["ic1"],
        },
      ],
    });
    // 只有 auth + gateway 的 task, 缺 billing
    const plan = mkPlan([
      mkTask("T01", { service: "auth", provides: ["C-auth"] }),
      mkTask("T02", { service: "gateway", consumes: ["C-auth"] }),
    ]);
    const result = checkPlan(plan, { contracts });
    const items = result.items.filter(
      (i) => i.check === "contract_provider_consumer_have_tasks",
    );
    expect(items.some((i) => !i.passed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 模块级用例
// ---------------------------------------------------------------------------

describe("TestTaskDetails", () => {
  test("complex high-risk task 缺必需 detail_ref → fail", () => {
    const plan = mkPlan([mkTask("T01", { risk: "high" })], Complexity.complex);
    const result = checkPlan(plan, { taskDetails: {} });
    const items = result.items.filter((i) => i.check === "task_detail_exists");
    expect(items.some((i) => !i.passed)).toBe(true);
    expect(items[0]!.detail).toContain("T01");
  });

  test("detail 引用当前 task 未声明的 AC 或 case → fail", () => {
    const plan = mkPlan([
      mkTask("T01", {
        detailRef: "planning/task-details/T01.yaml",
        refs: ["AC-001"],
        tests: 1,
      }),
    ], Complexity.complex);
    const detail = parseTaskDetail({
      task_id: "T01",
      business_logic_steps: ["实现主流程"],
      acceptance_context: [{ ref: "AC-404" }],
      verification_map: [{ acceptance_ref: "AC-001", planned_cases: ["missing-case"] }],
    });
    const result = checkPlan(plan, {
      taskDetails: { "planning/task-details/T01.yaml": detail },
    });
    expect(result.items.some((i) => i.check === "task_detail_acceptance_refs_match" && !i.passed)).toBe(true);
    expect(result.items.some((i) => i.check === "task_detail_planned_cases_match" && !i.passed)).toBe(true);
  });

  test("有效 detail 引用当前 task AC 与 planned case → pass", () => {
    const task = TaskSchema.parse({
      id: "T01",
      title: "T01",
      detail_ref: "planning/task-details/T01.yaml",
      allowed_write_paths: ["src/T01/**"],
      acceptance_refs: ["AC-001"],
      tests: [{ id: "T01-CASE-001", scenario: "s", checks: ["passed == true"] }],
      risk: "high",
    });
    const plan = mkPlan([task], Complexity.complex);
    const detail = parseTaskDetail({
      task_id: "T01",
      business_logic_steps: ["实现主流程"],
      acceptance_context: [{ ref: "AC-001" }],
      verification_map: [{ acceptance_ref: "AC-001", planned_cases: ["T01-CASE-001"] }],
      review_focus: ["检查边界"],
    });
    const result = checkPlan(plan, {
      taskDetails: { "planning/task-details/T01.yaml": detail },
    });
    const detailItems = result.items.filter((i) => i.check.startsWith("task_detail_"));
    expect(detailItems.length).toBeGreaterThan(0);
    expect(detailItems.every((i) => i.passed)).toBe(true);
  });
});

test("[py: test_default_path_overlap_detects_conflict] 缺省 pathOverlapFn 检出冲突", () => {
  const plan = mkPlan([
    mkTask("T01", { paths: ["src/shared/**"] }),
    mkTask("T02", { paths: ["src/shared/**"] }),
  ]);
  const result = checkPlan(plan);
  const items = result.items.filter((i) => i.check === "parallel_paths_disjoint");
  expect(items.some((i) => !i.passed)).toBe(true);
});

// ---------------------------------------------------------------------------
// 澄清证据 (用户决策 2026-06-28): medium/complex 裁量跳过澄清须留证
// ---------------------------------------------------------------------------

describe("TestClarificationEvidence", () => {
  const SKIP_BASIS = parseClarificationQuestions({
    questions: [],
    skip_basis: [
      { considered: "验证码位数", why_non_blocking: "默认 5 位纯数字, 无损" },
    ],
  });
  const WITH_QUESTIONS = parseClarificationQuestions({
    questions: [
      { id: "Q1", question: "接第三方?", why_blocking: "改拆分", default_if_unanswered: "后端自生成" },
    ],
  });
  const EMPTY = parseClarificationQuestions({ questions: [] }); // 空问题 + 空 skip_basis

  function evidenceItems(
    plan: ReturnType<typeof mkPlan>,
    clarification: ReturnType<typeof parseClarificationQuestions> | null,
  ) {
    const result = checkPlan(plan, { clarification });
    return result.items.filter((i) => i.check === "clarification_evidence");
  }

  test("不传 clarification 入参 → 不产生该检查项 (纯结构单测不受影响)", () => {
    const plan = mkPlan([mkTask("T01")], Complexity.medium);
    const result = checkPlan(plan); // 无 clarification key
    expect(result.items.some((i) => i.check === "clarification_evidence")).toBe(false);
  });

  test("simple 档豁免: 即便传 null 也不产生该检查项", () => {
    const plan = mkPlan([mkTask("T01")], Complexity.simple);
    expect(evidenceItems(plan, null).length).toBe(0);
  });

  test("medium + 缺 questions.json (null) → fail", () => {
    const plan = mkPlan([mkTask("T01")], Complexity.medium);
    const items = evidenceItems(plan, null);
    expect(items.length).toBe(1);
    expect(items[0]!.passed).toBe(false);
    expect(items[0]!.detail).toContain("questions.json");
  });

  test("medium + 空问题且空 skip_basis → fail (无证跳过)", () => {
    const plan = mkPlan([mkTask("T01")], Complexity.medium);
    const items = evidenceItems(plan, EMPTY);
    expect(items[0]!.passed).toBe(false);
    expect(items[0]!.detail).toContain("skip_basis");
  });

  test("medium + 非空 skip_basis → pass (裁量跳过留证)", () => {
    const plan = mkPlan([mkTask("T01")], Complexity.medium);
    const items = evidenceItems(plan, SKIP_BASIS);
    expect(items.length).toBe(1);
    expect(items[0]!.passed).toBe(true);
  });

  test("medium + 有阻塞问题 → pass (真有问题不算跳过)", () => {
    const plan = mkPlan([mkTask("T01")], Complexity.medium);
    expect(evidenceItems(plan, WITH_QUESTIONS)[0]!.passed).toBe(true);
  });

  test("complex + 空 skip_basis → fail (与 medium 同规则)", () => {
    const plan = mkPlan([mkTask("T01")], Complexity.complex);
    expect(evidenceItems(plan, EMPTY)[0]!.passed).toBe(false);
  });
});

test("[py: test_contract_service_task_without_explicit_contract_declaration_fails]", () => {
  const contracts: ServiceContracts = ServiceContractsSchema.parse({
    contracts: [
      {
        id: "C-auth",
        provider: "auth",
        consumers: ["gateway"],
        surface: "token",
        integration_cases: ["ic1"],
      },
    ],
  });
  const plan = mkPlan([
    mkTask("T01", { service: "auth", provides: [] }),
    mkTask("T02", { service: "gateway", consumes: [] }),
  ]);
  const result = checkPlan(plan, { contracts });
  const items = result.items.filter(
    (i) => i.check === "contract_provider_consumer_have_tasks",
  );
  expect(items.some((i) => !i.passed)).toBe(true);
  expect(items[0]!.detail).toContain("provides_contracts");
  expect(items[0]!.detail).toContain("consumes_contracts");
});
