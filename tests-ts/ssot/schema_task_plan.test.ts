/**
 * task_plan schema 等价测试 (P4-M1)。
 *
 * 行为权威: Python `tests/test_schema_task_plan.py` + `loop_engineering/schema/task_plan.py`。
 * 被测实现: `packages/ssot-ts/src/schema/task_plan.ts` (zod)。
 *
 * 覆盖: Task 默认值、YAML 往返 (用 JSON 结构等价模拟)、schema 真实键、checks 列表、
 * status 四态、from_dict 入口、非法 complexity。
 */
import { test, expect } from "bun:test";
import {
  RiskLevel,
  TaskStatus,
  TaskStatusSchema,
  TaskSchema,
  TestCaseSchema,
  TaskPlanSchema,
  TaskDetailSchema,
  parseTaskPlan,
  parseTaskDetail,
} from "@e2e-loop/ssot";

test("[py: test_task_defaults] Task 默认值: depends_on=[] exclusive=false risk=normal status=pending attempt=0", () => {
  const t = TaskSchema.parse({
    id: "T01",
    title: "示例",
    allowed_write_paths: ["src/**"],
    acceptance_refs: ["AC-001"],
  });
  expect(t.depends_on).toEqual([]);
  expect(t.exclusive).toBe(false);
  expect(t.risk).toBe(RiskLevel.normal);
  expect(t.tests).toEqual([]);
  expect(t.status).toBe(TaskStatus.pending);
  expect(t.attempt).toBe(0);
  expect(t.detail_ref).toBeNull();
  // 多服务字段默认
  expect(t.service).toBeNull();
  expect(t.provides_contracts).toEqual([]);
  expect(t.consumes_contracts).toEqual([]);
});

test("[py: test_task_plan_yaml_roundtrip] 解析 → 结构往返一致 (含嵌套 tests/多服务字段)", () => {
  const plan = parseTaskPlan({
    complexity: "complex",
    tasks: [
      {
        id: "T01",
        title: "实现校验",
        allowed_write_paths: ["src/clarification/**", "tests/clarification/**"],
        depends_on: [],
        acceptance_refs: ["AC-001", "AC-002"],
        exclusive: false,
        risk: "normal",
        tests: [
          {
            id: "T01-CASE-001",
            scenario: "合法产物通过校验",
            checks: ["passed == true", "blocked_reasons == []"],
          },
        ],
      },
      {
        id: "T02",
        title: "下游 task",
        allowed_write_paths: ["src/downstream/**"],
        depends_on: ["T01"],
        acceptance_refs: ["AC-003"],
        service: "gateway",
        consumes_contracts: ["C-auth-token"],
      },
    ],
  });
  // 序列化再解析模拟 yaml 往返
  const plan2 = parseTaskPlan(JSON.parse(JSON.stringify(plan)));
  expect(plan2.complexity).toBe(plan.complexity);
  expect(plan2.tasks.length).toBe(2);
  expect(plan2.tasks[0].id).toBe("T01");
  expect(plan2.tasks[0].tests[0].checks).toEqual([
    "passed == true",
    "blocked_reasons == []",
  ]);
  expect(plan2.tasks[1].service).toBe("gateway");
  expect(plan2.tasks[1].consumes_contracts).toEqual(["C-auth-token"]);
});

test("[detail] TaskPlan 保留 detail_ref, TaskDetail 支持验收上下文/映射/review focus", () => {
  const plan = parseTaskPlan({
    complexity: "complex",
    tasks: [
      {
        id: "T01",
        title: "带细节的 task",
        detail_ref: "planning/task-details/T01.yaml",
        allowed_write_paths: ["src/auth/**"],
        acceptance_refs: ["AC-001"],
        tests: [{ id: "T01-CASE-001", scenario: "happy", checks: ["passed == true"] }],
      },
    ],
  });
  expect(plan.tasks[0]!.detail_ref).toBe("planning/task-details/T01.yaml");

  const detail = parseTaskDetail({
    task_id: "T01",
    summary: "接入验证码",
    business_logic_steps: ["先校验验证码", "通过后复用原登录流程"],
    acceptance_context: [
      {
        ref: "AC-001",
        intent: "验证码通过后进入密码校验",
        observable_behavior: "原登录路径保持不变",
        implementation_implications: ["验证码校验在密码校验前"],
      },
    ],
    verification_map: [
      { acceptance_ref: "AC-001", planned_cases: ["T01-CASE-001"], notes: "主路径" },
    ],
    review_focus: ["检查 session 签发未被改动"],
  });
  expect(detail.schema).toBe("loop-engineering.task-detail.v1");
  expect(detail.acceptance_context[0]!.ref).toBe("AC-001");
  expect(detail.verification_map[0]!.planned_cases).toEqual(["T01-CASE-001"]);
  expect(detail.review_focus).toEqual(["检查 session 签发未被改动"]);
  expect(() => TaskDetailSchema.parse({ business_logic_steps: [] })).toThrow();
});

test("[py: test_task_plan_alias_schema] 真实键是 `schema`, 默认 v2", () => {
  const plan = parseTaskPlan({
    complexity: "simple",
    tasks: [
      {
        id: "T01",
        title: "t",
        allowed_write_paths: ["a/**"],
        acceptance_refs: ["AC-001"],
      },
    ],
  });
  expect(plan.schema).toBe("loop-engineering.task-plan.v2");
  const raw = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
  expect("schema" in raw).toBe(true);
  expect(raw.schema).toBe("loop-engineering.task-plan.v2");
  // TS 侧不存在 schema_ 这个 Python 私名
  expect("schema_" in raw).toBe(false);
});

test("[py: test_task_plan_populate_by_name] 显式给 schema 或缺省都得同样的值", () => {
  const p1 = parseTaskPlan({
    schema: "loop-engineering.task-plan.v2",
    complexity: "simple",
    tasks: [],
  });
  const p2 = parseTaskPlan({ complexity: "simple", tasks: [] });
  expect(p1.schema).toBe(p2.schema);
  expect(p1.schema).toBe("loop-engineering.task-plan.v2");
});

test("[py: test_test_case_checks_is_list_of_str] checks 是字符串列表, 不解析内容", () => {
  const tc = TestCaseSchema.parse({
    id: "C1",
    scenario: "x",
    checks: ["passed == true", "'foo' in blocked_reasons", "count >= 1"],
  });
  expect(Array.isArray(tc.checks)).toBe(true);
  expect(tc.checks.every((c) => typeof c === "string")).toBe(true);
  expect(tc.checks[1]).toBe("'foo' in blocked_reasons");
});

test("[py: test_task_status_four_states] task.status 四态", () => {
  expect(new Set(TaskStatusSchema.options)).toEqual(
    new Set(["pending", "running", "blocked", "complete"]),
  );
});

test("[py: test_task_plan_from_dict] from_dict 入口 (parseTaskPlan)", () => {
  const plan = parseTaskPlan({
    schema: "loop-engineering.task-plan.v2",
    complexity: "medium",
    tasks: [],
  });
  expect(plan.complexity).toBe("medium");
});

test("[py: test_task_plan_invalid_complexity] 非法 complexity → 抛错", () => {
  expect(() => TaskPlanSchema.parse({ complexity: "bogus", tasks: [] })).toThrow();
});
