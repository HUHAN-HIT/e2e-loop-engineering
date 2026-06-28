/**
 * clarification schema 等价测试 (P4-M1)。
 *
 * 行为权威: Python `tests/test_schema_clarification.py` + `loop_engineering/schema/clarification.py`。
 * 被测实现: `packages/ssot-ts/src/schema/clarification.ts` (zod)。
 *
 * 覆盖: Question 三字段非空校验 (含纯空白)、空 questions 跳过、JSON 往返、answers 默认。
 */
import { test, expect } from "bun:test";
import {
  QuestionSchema,
  ClarificationQuestionsSchema,
  ClarificationSkipBasisItemSchema,
  ClarificationAnswersSchema,
  parseClarificationQuestions,
} from "@e2e-loop/ssot";

test("[py: test_question_requires_non_empty_fields] question/why_blocking/default 不得为空 (含纯空白)", () => {
  // question 纯空白
  expect(() =>
    QuestionSchema.parse({
      id: "Q1",
      question: "   ",
      why_blocking: "阻塞",
      default_if_unanswered: "采用 X",
    }),
  ).toThrow();
  // why_blocking 空
  expect(() =>
    QuestionSchema.parse({
      id: "Q1",
      question: "用 A 还是 B?",
      why_blocking: "",
      default_if_unanswered: "采用 A",
    }),
  ).toThrow();
  // default_if_unanswered 空
  expect(() =>
    QuestionSchema.parse({
      id: "Q1",
      question: "用 A 还是 B?",
      why_blocking: "阻塞选型",
      default_if_unanswered: "",
    }),
  ).toThrow();
});

test("[py: test_question_ok] 合法 Question", () => {
  const q = QuestionSchema.parse({
    id: "Q1",
    question: "需要支持多租户吗?",
    why_blocking: "影响数据模型选型",
    default_if_unanswered: "单租户",
  });
  expect(q.id).toBe("Q1");
});

test("[py: test_clarification_questions_empty_ok] questions=[] 且 can_proceed_with_defaults=true", () => {
  const cq = parseClarificationQuestions({ questions: [] });
  expect(cq.questions).toEqual([]);
  expect(cq.can_proceed_with_defaults).toBe(true);
  expect(cq.schema).toBe("loop-engineering.clarification.v2");
});

test("[py: test_clarification_json_roundtrip] questions.json 往返一致 + schema 真实键", () => {
  const cq = parseClarificationQuestions({
    questions: [
      {
        id: "Q1",
        question: "需要多租户?",
        why_blocking: "影响数据模型",
        default_if_unanswered: "单租户",
      },
      {
        id: "Q2",
        question: "异步还是同步?",
        why_blocking: "影响接口形态",
        default_if_unanswered: "同步",
      },
    ],
    can_proceed_with_defaults: false,
  });
  const raw = JSON.parse(JSON.stringify(cq)) as Record<string, unknown>;
  const cq2 = parseClarificationQuestions(raw);
  expect(cq2.questions.length).toBe(2);
  expect(cq2.questions[0].id).toBe("Q1");
  expect(cq2.questions[1].default_if_unanswered).toBe("同步");
  expect(cq2.can_proceed_with_defaults).toBe(false);
  // 序列化字段名为 schema, 不是 schema_
  expect("schema" in raw).toBe(true);
  expect(raw.schema).toBe("loop-engineering.clarification.v2");
  expect("schema_" in raw).toBe(false);
});

// ---------------------------------------------------------------------------
// skip_basis: 裁量跳过澄清的可审计留证 (用户决策 2026-06-28)
// ---------------------------------------------------------------------------

test("skip_basis 默认空数组; 缺省的旧 questions.json 仍合法 (向后兼容)", () => {
  const cq = parseClarificationQuestions({ questions: [] });
  expect(cq.skip_basis).toEqual([]);
  // schema 版本不变 (新增字段带默认, 不破坏旧产物)
  expect(cq.schema).toBe("loop-engineering.clarification.v2");
});

test("合法 skip_basis 项 (considered + why_non_blocking 非空)", () => {
  const item = ClarificationSkipBasisItemSchema.parse({
    considered: "图形验证码是后端生成还是接第三方",
    why_non_blocking: "可给无损默认: 后端自生成 SVG, 错了仅局部返工",
  });
  expect(item.considered).toContain("验证码");
});

test("skip_basis 项两字段不得为空 (含纯空白) — 杜绝空洞留证", () => {
  // considered 空
  expect(() =>
    ClarificationSkipBasisItemSchema.parse({
      considered: "   ",
      why_non_blocking: "可给默认",
    }),
  ).toThrow();
  // why_non_blocking 空
  expect(() =>
    ClarificationSkipBasisItemSchema.parse({
      considered: "某歧义点",
      why_non_blocking: "",
    }),
  ).toThrow();
});

test("空 questions + 非空 skip_basis 往返一致 (裁量跳过留证产物)", () => {
  const cq = parseClarificationQuestions({
    questions: [],
    skip_basis: [
      { considered: "过期时间", why_non_blocking: "默认 5 分钟, 无损" },
      { considered: "大小写敏感", why_non_blocking: "默认不敏感比对" },
    ],
  });
  const raw = JSON.parse(JSON.stringify(cq)) as Record<string, unknown>;
  const cq2 = parseClarificationQuestions(raw);
  expect(cq2.questions).toEqual([]);
  expect(cq2.skip_basis.length).toBe(2);
  expect(cq2.skip_basis[0].considered).toBe("过期时间");
  expect("skip_basis" in raw).toBe(true);
});

test("[py: test_clarification_answers_default_empty] answers 默认空 dict", () => {
  const a = ClarificationAnswersSchema.parse({});
  expect(a.answers).toEqual({});
  const a2 = ClarificationAnswersSchema.parse({
    answers: { Q1: "采用默认", Q2: "多租户" },
  });
  expect(a2.answers.Q1).toBe("采用默认");
  expect(a2.schema).toBe("loop-engineering.clarification-answers.v1");
});
