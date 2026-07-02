/**
 * checks 文法求值器等价测试 (P4-M2 go/no-go)。
 *
 * 行为权威: Python `tests/test_checks_eval.py` + `loop_engineering/checklists/checks_eval.py`。
 * 被测实现: `packages/ssot-ts/src/checklists/checks_eval.ts`。
 *
 * 覆盖:
 * - parseCheck 文法白名单 (各合法 op / in / not in 优先级 / 数组 rhs / 拒绝函数调用 /
 *   嵌套 / 未知 op / 未闭合引号 / 顶层裸词拒绝 / 数组内裸词当字符串)
 * - evalCheck 未知字段失败、类型不兼容、in/not in 成员 (含非数组字段报错)、数字比较各 op
 * - evalCase / evalTask 的 planned-未跑、worker 多跑、worker 自创字段防御
 * - case 输出 schema {id, passed, failure_reason} 固定三字段
 */
import { test, expect, describe } from "bun:test";
import {
  Op,
  CheckParseError,
  evalCase,
  evalCheck,
  evalTask,
  parseCheck,
} from "../../packages/ssot-ts/src/checklists/checks_eval.js";
import type { Check } from "../../packages/ssot-ts/src/checklists/checks_eval.js";
import {
  TestCaseResultSchema,
  TestResultsSchema,
} from "../../packages/ssot-ts/src/schema/artifacts.js";
import type { TestCaseResult, TestResults } from "../../packages/ssot-ts/src/schema/artifacts.js";
import { TestCaseSchema } from "../../packages/ssot-ts/src/schema/task_plan.js";
import type { TestCase } from "../../packages/ssot-ts/src/schema/task_plan.js";

// ---------------------------------------------------------------------------
// parseCheck —— 文法白名单
// ---------------------------------------------------------------------------

describe("TestParseCheck", () => {
  test("[py: test_parse_eq_bool] passed == true", () => {
    const c = parseCheck("passed == true");
    expect(c.lhs).toBe("passed");
    expect(c.op).toBe(Op.EQ);
    expect(c.rhs).toBe(true);
  });

  test("[py: test_parse_ne_string] lhs 字段, rhs 引号字符串", () => {
    const c = parseCheck("blocked_reasons != 'not_approved'");
    expect(c.lhs).toBe("blocked_reasons");
    expect(c.op).toBe(Op.NE);
    expect(c.rhs).toBe("not_approved");
  });

  test("[py: test_parse_in_array] '<scalar>' in <array-field> 规范化", () => {
    const c = parseCheck("'clarification_not_approved' in blocked_reasons");
    expect(c.lhs).toBe("blocked_reasons");
    expect(c.op).toBe(Op.IN);
    expect(c.rhs).toBe("clarification_not_approved");
  });

  test("[py: test_parse_not_in] not in 优先级 + 双向语法", () => {
    // x not in 'foo' —— 字段在前, rhs 引号字符串
    const c2 = parseCheck("x not in 'foo'");
    expect(c2.op).toBe(Op.NOT_IN);
    expect(c2.rhs).toBe("foo");
    // 反向语法 (字面量在前): 'foo' not in x —— x 是字段路径, 合法
    const c3 = parseCheck("'foo' not in x");
    expect(c3.op).toBe(Op.NOT_IN);
    expect(c3.lhs).toBe("x");
    expect(c3.rhs).toBe("foo");
    // 关键: 不能误识别为 op=IN (验证 not in 优先级)
    const c4 = parseCheck("'foo' in tags");
    expect(c4.op).toBe(Op.IN);
    // not in 必须整个匹配, 不会把 'not in' 拆成两段
    const c5 = parseCheck("'foo' not in tags");
    expect(c5.op).toBe(Op.NOT_IN);
  });

  test("[py: test_parse_numeric_comparisons] < <= > >= 数字 rhs", () => {
    const cases: [string, Op][] = [
      ["count < 10", Op.LT],
      ["count <= 10", Op.LE],
      ["count > 10", Op.GT],
      ["count >= 10", Op.GE],
    ];
    for (const [raw, op] of cases) {
      const c = parseCheck(raw);
      expect(c.op).toBe(op);
      expect(c.lhs).toBe("count");
      expect(c.rhs).toBe(10);
    }
  });

  test("[py: test_parse_rhs_array] rhs 方括号数组, 内部裸词当字符串", () => {
    const c = parseCheck("x == [a, b]");
    expect(c.op).toBe(Op.EQ);
    expect(c.rhs).toEqual(["a", "b"]);
  });

  test("[py: test_parse_reject_function_call] 拒绝函数调用 (括号)", () => {
    let caught: unknown;
    try {
      parseCheck("len(x) == 3");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CheckParseError);
    const err = caught as CheckParseError;
    expect(err.reason.includes("括号") || err.reason.includes("函数")).toBe(true);
  });

  test("[py: test_parse_reject_nested_expr] 拒绝嵌套表达式", () => {
    expect(() => parseCheck("(a == b) == true")).toThrow(CheckParseError);
  });

  test("[py: test_parse_reject_unknown_op] := 不是合法 op", () => {
    let caught: unknown;
    try {
      parseCheck("x := y");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CheckParseError);
    const err = caught as CheckParseError;
    expect(err.reason.toLowerCase().includes("op")).toBe(true);
  });

  test("[py: test_parse_reject_unclosed_quote] 未闭合引号", () => {
    let caught: unknown;
    try {
      parseCheck("x == 'abc");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CheckParseError);
    const err = caught as CheckParseError;
    expect(err.reason.includes("闭合")).toBe(true);
  });

  // ----- 补充分支覆盖 (Python 隐含但测试未直接覆盖的解析路径) -----

  test("[补充] 顶层 rhs 裸词 (非 true/false/null) 被拒绝, 提示加引号", () => {
    let caught: unknown;
    try {
      parseCheck("x == foo");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CheckParseError);
    const err = caught as CheckParseError;
    expect(err.reason.includes("裸词")).toBe(true);
  });

  test("[补充] 顶层 rhs 支持 false / null / none / 负数 / 浮点", () => {
    expect(parseCheck("passed == false").rhs).toBe(false);
    expect(parseCheck("x == null").rhs).toBeNull();
    expect(parseCheck("x == none").rhs).toBeNull();
    expect(parseCheck("delta == -3").rhs).toBe(-3);
    expect(parseCheck("ratio == 1.5").rhs).toBe(1.5);
  });

  test("[补充] 空字符串 / 仅空白 → 报错", () => {
    expect(() => parseCheck("")).toThrow(CheckParseError);
    expect(() => parseCheck("   ")).toThrow(CheckParseError);
  });

  test("[补充] 非字符串 check → 报错", () => {
    // @ts-expect-error 故意传非字符串验证防御
    expect(() => parseCheck(123)).toThrow(CheckParseError);
  });

  test("[补充] 缺 op (只有 lhs) → 报错", () => {
    expect(() => parseCheck("passed")).toThrow(CheckParseError);
  });

  test("[补充] rhs 后存在残余内容 → 报错", () => {
    let caught: unknown;
    try {
      parseCheck("x == 1 2");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CheckParseError);
    expect((caught as CheckParseError).reason.includes("未消化")).toBe(true);
  });

  test("[补充] 数组未闭合 → 报错", () => {
    expect(() => parseCheck("x == [a, b")).toThrow(CheckParseError);
  });

  test("[补充] 数字含多个小数点 → 报错", () => {
    expect(() => parseCheck("x == 1.2.3")).toThrow(CheckParseError);
  });

  test("[补充] 字面量开头但 op 不是 in/not in → 报错", () => {
    let caught: unknown;
    try {
      parseCheck("'a' == x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CheckParseError);
    expect((caught as CheckParseError).reason.includes("in")).toBe(true);
  });

  test("[补充] 花括号被拒绝", () => {
    let caught: unknown;
    try {
      parseCheck("x == {a}");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CheckParseError);
    expect((caught as CheckParseError).reason.includes("花括号")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evalCheck
// ---------------------------------------------------------------------------

function chk(raw: string): Check {
  return parseCheck(raw);
}

describe("TestEvalCheck", () => {
  test("[py: test_eval_eq_bool_pass]", () => {
    const r = evalCheck(chk("passed == true"), { passed: true });
    expect(r.passed).toBe(true);
    expect(r.error).toBeNull();
  });

  test("[py: test_eval_eq_bool_fail]", () => {
    const r = evalCheck(chk("passed == true"), { passed: false });
    expect(r.passed).toBe(false);
    expect(r.error).toBeNull();
  });

  test("[py: test_eval_unknown_field_fails] 未知字段路径 → 失败 + error", () => {
    const r = evalCheck(chk("'x' in blocked_reasons"), {
      passed: true,
      failure_reason: "",
    });
    expect(r.passed).toBe(false);
    expect(r.error).not.toBeNull();
    expect(r.error!.includes("blocked_reasons")).toBe(true);
  });

  test("[py: test_eval_in_membership] 'a' in tags (字段值数组)", () => {
    const r = evalCheck(chk("'a' in tags"), { tags: ["a", "b"] });
    expect(r.passed).toBe(true);
    expect(r.error).toBeNull();
  });

  test("[py: test_eval_not_in_membership] 'c' not in tags", () => {
    const r = evalCheck(chk("'c' not in tags"), { tags: ["a", "b"] });
    expect(r.passed).toBe(true);
    expect(r.error).toBeNull();
  });

  test("[py: test_eval_numeric_lt] count < 10", () => {
    const r = evalCheck(chk("count < 10"), { count: 5 });
    expect(r.passed).toBe(true);
    expect(r.error).toBeNull();
  });

  test("[py: test_eval_type_mismatch_fails] bool 与 int 比较 → 失败 + error", () => {
    const r = evalCheck(chk("passed < 10"), { passed: true });
    expect(r.passed).toBe(false);
    expect(r.error).not.toBeNull();
    expect(r.error!.includes("数字") || r.error!.includes("类型")).toBe(true);
  });

  // ----- 补充分支覆盖 -----

  test("[补充] != 求值", () => {
    expect(evalCheck(chk("failure_reason != 'x'"), { failure_reason: "y" }).passed).toBe(
      true,
    );
    expect(evalCheck(chk("failure_reason != 'x'"), { failure_reason: "x" }).passed).toBe(
      false,
    );
  });

  test("[补充] in 对非数组字段 → 失败 + error 含数组提示", () => {
    const r = evalCheck(chk("'a' in passed"), { passed: true });
    expect(r.passed).toBe(false);
    expect(r.error!.includes("数组")).toBe(true);
  });

  test("[补充] not in 对非数组字段 → 失败 + error 含数组提示", () => {
    const r = evalCheck(chk("'a' not in passed"), { passed: true });
    expect(r.passed).toBe(false);
    expect(r.error!.includes("数组")).toBe(true);
  });

  test("[补充] <= / > / >= 全分支", () => {
    expect(evalCheck(chk("count <= 10"), { count: 10 }).passed).toBe(true);
    expect(evalCheck(chk("count <= 10"), { count: 11 }).passed).toBe(false);
    expect(evalCheck(chk("count > 10"), { count: 11 }).passed).toBe(true);
    expect(evalCheck(chk("count > 10"), { count: 10 }).passed).toBe(false);
    expect(evalCheck(chk("count >= 10"), { count: 10 }).passed).toBe(true);
    expect(evalCheck(chk("count >= 10"), { count: 9 }).passed).toBe(false);
  });

  test("[补充] 数字比较 rhs 非数字 (字段是数字但 rhs 不可能非数字, 用反例: 字段非数字)", () => {
    // 字段是字符串 → 失败 (字段非数字分支)
    const r = evalCheck(chk("failure_reason < 10"), { failure_reason: "abc" });
    expect(r.passed).toBe(false);
    expect(r.error!.includes("数字")).toBe(true);
  });

  test("[补充] == 对数组 rhs 做深比较", () => {
    expect(evalCheck(chk("tags == [a, b]"), { tags: ["a", "b"] }).passed).toBe(true);
    expect(evalCheck(chk("tags == [a, b]"), { tags: ["a", "c"] }).passed).toBe(false);
  });

  test("[补充] context 缺键 (字段路径不在 fields) → unknown field", () => {
    const r = evalCheck(chk("missing == true"), { passed: true });
    expect(r.passed).toBe(false);
    expect(r.error!.includes("unknown field")).toBe(true);
    expect(r.error!.includes("missing")).toBe(true);
  });

  // ----- in / not in 对 string 字段的子串语义 (三字段 schema 下唯一能用 in 的负路径) -----

  test("[子串] 'captcha' in failure_reason 命中 → pass", () => {
    const r = evalCheck(chk("'captcha' in failure_reason"), {
      failure_reason: "captcha_invalid",
    });
    expect(r.passed).toBe(true);
    expect(r.error).toBeNull();
  });

  test("[子串] 'captcha' in failure_reason 未命中 (空串) → fail 但无类型错误", () => {
    const r = evalCheck(chk("'captcha' in failure_reason"), { failure_reason: "" });
    expect(r.passed).toBe(false);
    expect(r.error).toBeNull();
  });

  test("[子串] 'x' not in failure_reason 取反语义", () => {
    // 不含 x → not in 为真
    const r1 = evalCheck(chk("'x' not in failure_reason"), { failure_reason: "abc" });
    expect(r1.passed).toBe(true);
    expect(r1.error).toBeNull();
    // 含 x → not in 为假
    const r2 = evalCheck(chk("'x' not in failure_reason"), { failure_reason: "axc" });
    expect(r2.passed).toBe(false);
    expect(r2.error).toBeNull();
  });

  test("[子串] rhs 非 string 却对 string 字段用 in → 保持类型错误行为", () => {
    // 数字字面量 in string 字段: 既非 array 也非 (string,string), 应报类型错误
    const r = evalCheck(chk("1 in failure_reason"), { failure_reason: "1abc" });
    expect(r.passed).toBe(false);
    expect(r.error).not.toBeNull();
  });

  test("[子串] 数组语义不变: 'a' in tags 仍按成员判定", () => {
    expect(evalCheck(chk("'a' in tags"), { tags: ["a", "b"] }).passed).toBe(true);
    expect(evalCheck(chk("'z' in tags"), { tags: ["a", "b"] }).passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evalTask / evalCase
// ---------------------------------------------------------------------------

function makeCase(caseId: string, checks: string[]): TestCase {
  return TestCaseSchema.parse({ id: caseId, scenario: `scenario for ${caseId}`, checks });
}

function makeCaseResult(
  caseId: string,
  passed: boolean,
  failureReason = "",
): TestCaseResult {
  return TestCaseResultSchema.parse({
    id: caseId,
    passed,
    failure_reason: failureReason,
  });
}

function makeResults(testsGreen: boolean, cases: TestCaseResult[]): TestResults {
  return TestResultsSchema.parse({ tests_green: testsGreen, cases });
}

describe("TestEvalTask", () => {
  test("[py: test_eval_task_all_pass]", () => {
    const testCases = [
      makeCase("c1", ["passed == true"]),
      makeCase("c2", ["passed == true"]),
      makeCase("c3", ["passed == true"]),
    ];
    const results = makeResults(true, [
      makeCaseResult("c1", true),
      makeCaseResult("c2", true),
      makeCaseResult("c3", true),
    ]);
    const r = evalTask(results, testCases, "t1");
    expect(r.task_id).toBe("t1");
    expect(r.tests_green).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(r.case_results.length).toBe(3);
  });

  test("[py: test_eval_task_missing_case_fails] planned 但 worker 未跑 → 失败", () => {
    const testCases = [
      makeCase("c1", ["passed == true"]),
      makeCase("c2", ["passed == true"]),
    ];
    const results = makeResults(false, [makeCaseResult("c1", true)]); // c2 没跑
    const r = evalTask(results, testCases, "t1");
    expect(r.tests_green).toBe(false);
    const c2 = r.case_results.find((cr) => cr.case_id === "c2")!;
    expect(c2.passed).toBe(false);
    expect(c2.check_results.some((c) => (c.error ?? "").includes("not run"))).toBe(true);
  });

  test("[py: test_eval_task_extra_case_warns] worker 多跑未 planned → warning", () => {
    const testCases = [makeCase("c1", ["passed == true"])];
    const results = makeResults(true, [
      makeCaseResult("c1", true),
      makeCaseResult("c2", true), // extra
    ]);
    const r = evalTask(results, testCases, "t1");
    // extra case 不直接导致 tests_green 失败 (但会上报 warning)
    expect(r.tests_green).toBe(true);
    expect(r.warnings.some((w) => w.includes("extra case"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("c2"))).toBe(true);
  });

  test("[py: test_eval_task_worker_invents_field] eval_case 仅取三字段, 引用自创字段判失败", () => {
    const c = makeCase("c1", ["passed == true"]);
    const cr = makeCaseResult("c1", true);
    const res = evalCase(c, cr);
    expect(res.case_id).toBe("c1");
    expect(res.passed).toBe(true);
    // 引用自创字段 → 字段不存在, 判失败
    const case2 = makeCase("c2", ["my_invented_field == true"]);
    const cr2 = makeCaseResult("c2", true);
    const res2 = evalCase(case2, cr2);
    expect(res2.passed).toBe(false);
    expect(
      res2.check_results.some((c) => (c.error ?? "").includes("my_invented_field")),
    ).toBe(true);
  });

  // ----- 补充: case 输出 schema 固定三字段 + 解析错落入 check 结果 -----

  test("[补充] eval_case 暴露三固定字段 id/passed/failure_reason", () => {
    const c = makeCase("c1", [
      "id == 'c1'",
      "passed == true",
      "failure_reason == ''",
    ]);
    const cr = makeCaseResult("c1", true, "");
    const res = evalCase(c, cr);
    expect(res.passed).toBe(true);
    expect(res.check_results.length).toBe(3);
    expect(res.check_results.every((r) => r.error === null)).toBe(true);
  });

  test("[补充] case 内非法 check → 该 check 落 parse error, case 失败", () => {
    const c = makeCase("c1", ["len(passed) == 1"]);
    const cr = makeCaseResult("c1", true);
    const res = evalCase(c, cr);
    expect(res.passed).toBe(false);
    expect(res.check_results.some((r) => (r.error ?? "").includes("parse error"))).toBe(
      true,
    );
  });

  test("[补充] 无 check 的 case → passed=false (至少一条 check 才算过)", () => {
    const c = makeCase("c1", []);
    const cr = makeCaseResult("c1", true);
    const res = evalCase(c, cr);
    expect(res.passed).toBe(false);
  });

  test("[补充] 无 planned case 的 task → tests_green=false", () => {
    const results = makeResults(true, []);
    const r = evalTask(results, [], "t1");
    expect(r.tests_green).toBe(false);
  });
});
