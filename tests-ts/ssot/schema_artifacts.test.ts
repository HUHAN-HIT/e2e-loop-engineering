/**
 * artifacts schema 等价测试 (P4-M1)。
 *
 * 行为权威: Python `tests/test_schema_artifacts.py` + `loop_engineering/schema/artifacts.py`。
 * 被测实现: `packages/ssot-ts/src/schema/artifacts.ts` (zod)。
 *
 * 覆盖: extra forbid (strict)、TestResults 软约束告警、key_diffs is_meaningful、
 * plan-amendment 非空硬校验、key-diffs 往返、ContractChange。
 */
import { test, expect } from "bun:test";
import {
  ContractChangeSchema,
  KeyDiffEntrySchema,
  KeyDiffsFileSchema,
  PlanAmendmentNeededSchema,
  TestCaseResultSchema,
  TestResultsSchema,
  isMeaningful,
} from "@e2e-loop/ssot";

test("[py: test_test_case_result_extra_forbidden] TestCaseResult 传未知字段 → 抛错", () => {
  expect(() =>
    TestCaseResultSchema.parse({ id: "C1", passed: true, foo: "bar" }),
  ).toThrow(/foo|Unrecognized/);
});

test("[py: test_test_case_result_ok] 合法 case result", () => {
  const r = TestCaseResultSchema.parse({
    id: "C1",
    passed: true,
    failure_reason: "",
  });
  expect(r.passed).toBe(true);
  const r2 = TestCaseResultSchema.parse({
    id: "C2",
    passed: false,
    failure_reason: "assertion failed",
  });
  expect(r2.failure_reason).toBe("assertion failed");
});

test("[补充] TestCaseResult.failure_reason 默认空串", () => {
  const r = TestCaseResultSchema.parse({ id: "C1", passed: true });
  expect(r.failure_reason).toBe("");
});

test("[py: test_test_results_extra_forbidden] TestResults 传未知字段 → 抛错", () => {
  expect(() =>
    TestResultsSchema.parse({ tests_green: true, cases: [], bogus_field: 1 }),
  ).toThrow();
});

test("[py: test_test_results_consistency_warning] tests_green 与 cases.passed 不一致 → warn 但不抛错", () => {
  const orig = console.warn;
  let warned = false;
  console.warn = () => {
    warned = true;
  };
  try {
    // 不一致: tests_green=true 但有 case passed=false → 应 warn 且解析成功
    const tr = TestResultsSchema.parse({
      tests_green: true,
      cases: [{ id: "C1", passed: false, failure_reason: "fail" }],
    });
    expect(tr.tests_green).toBe(true);
    expect(warned).toBe(true);

    // 一致时不 warn
    warned = false;
    TestResultsSchema.parse({
      tests_green: false,
      cases: [{ id: "C1", passed: false }],
    });
    expect(warned).toBe(false);
  } finally {
    console.warn = orig;
  }
});

test("[py: test_key_diffs_file_is_meaningful] 空 → false; 非空 → true", () => {
  const empty = KeyDiffsFileSchema.parse({ task_id: "T01", key_diffs: [] });
  expect(isMeaningful(empty)).toBe(false);
  const nonEmpty = KeyDiffsFileSchema.parse({
    task_id: "T01",
    key_diffs: [
      { file: "src/x.py", change: "新增校验", why: "实现 AC-001", risk: "无" },
    ],
  });
  expect(isMeaningful(nonEmpty)).toBe(true);
});

test("[py: test_plan_amendment_requires_touched_refs] touched_acceptance_refs=[] → 抛错", () => {
  expect(() =>
    PlanAmendmentNeededSchema.parse({
      reason: "用例不可执行",
      touched_acceptance_refs: [],
    }),
  ).toThrow(/touched_acceptance_refs/);
});

test("[py: test_plan_amendment_ok] 合法 amendment, status 默认", () => {
  const a = PlanAmendmentNeededSchema.parse({
    reason: "T01-CASE-002 假设不成立",
    touched_acceptance_refs: ["AC-002"],
  });
  expect(a.status).toBe("plan-amendment-needed");
});

test("[py: test_key_diffs_yaml_roundtrip] key-diffs 结构往返一致 + schema 默认", () => {
  const f = KeyDiffsFileSchema.parse({
    task_id: "T01",
    key_diffs: [
      {
        file: "src/auth.py",
        change: "加 token 校验",
        why: "实现 AC-007",
        risk: "影响登录路径",
      },
    ],
  });
  const f2 = KeyDiffsFileSchema.parse(JSON.parse(JSON.stringify(f)));
  expect(f2.task_id).toBe("T01");
  expect(f2.key_diffs.length).toBe(1);
  expect(f2.key_diffs[0].file).toBe("src/auth.py");
  expect(f2.key_diffs[0].risk).toBe("影响登录路径");
  expect(f2.schema).toBe("loop-engineering.key-diffs.v1");
});

test("[补充] KeyDiffEntry 四字段必填", () => {
  expect(() =>
    KeyDiffEntrySchema.parse({ file: "a", change: "b", why: "c" }),
  ).toThrow();
});

test("[py: test_contract_change_name_field] ContractChange 只携带 contract id 引用", () => {
  const cc = ContractChangeSchema.parse({ name: "C-auth-token" });
  expect(cc.name).toBe("C-auth-token");
});
