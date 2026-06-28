/**
 * 澄清问题模型 (CLARIFYING phase, 多数 run 跳过; zod 版, 等价 Python
 * `loop_engineering/schema/clarification.py`)。
 *
 * 规范源: design §1 (主流程: CLARIFYING 仅当有阻塞性歧义)、§6 (clarification/ 目录)。
 *
 * 与 Pydantic 的差异处理:
 * - Python `_require_non_empty` 校验 question/why_blocking/default_if_unanswered 三字段
 *   `.strip()` 后非空 (不修改原值) → 每字段 zod `.refine(v => v.trim().length > 0)`,
 *   同样保留原始字符串 (不 trim 落库)。
 * - 真实键 `schema` 默认值复刻 Python `schema_` 的 alias 默认。
 */
import { z } from "zod";

/**
 * 单个阻塞性澄清问题 (design §1, §6)。
 * 四字段中 question / why_blocking / default_if_unanswered 不得为空字符串 ——
 * 澄清问题必填实质内容, 而非"这个你想要吗?"这类无信息问题。
 */
export const QuestionSchema = z.object({
  id: z.string(),
  question: z
    .string()
    .refine((v) => v.trim().length > 0, {
      message: "Question.question 不得为空字符串 (design: 澄清问题必填实质内容)",
    }),
  why_blocking: z
    .string()
    .refine((v) => v.trim().length > 0, {
      message: "Question.why_blocking 不得为空字符串 (design: 澄清问题必填实质内容)",
    }),
  default_if_unanswered: z
    .string()
    .refine((v) => v.trim().length > 0, {
      message:
        "Question.default_if_unanswered 不得为空字符串 (design: 澄清问题必填实质内容)",
    }),
});
export type Question = z.infer<typeof QuestionSchema>;

/**
 * 单条"裁量跳过澄清"的可审计留证 (design §1: CLARIFYING 可跳过但须落证)。
 *
 * 当协调器/finder 判定"无需澄清"(无阻塞性歧义) 时, 不再是无痕的状态跳转, 而是把
 * 这个判断固化成一条条证据: considered = 被评估过的歧义点, why_non_blocking = 为何
 * 它非阻塞 (可给无损默认 / 命中 glossary §2 反例)。两字段非空, 杜绝空洞的
 * "看了一遍没问题" 这类假合规留证。
 *
 * 适用边界: simple 档跳过是规则驱动 (complexity=simple 本身即证据), 不产 skip_basis;
 * 只有 medium/complex 的裁量跳过需要它 (见 plan_check checkClarificationEvidence)。
 */
export const ClarificationSkipBasisItemSchema = z.object({
  considered: z
    .string()
    .refine((v) => v.trim().length > 0, {
      message:
        "SkipBasisItem.considered 不得为空 (design: 裁量跳过须写明被评估的歧义点)",
    }),
  why_non_blocking: z
    .string()
    .refine((v) => v.trim().length > 0, {
      message:
        "SkipBasisItem.why_non_blocking 不得为空 (design: 须写明为何非阻塞/可给无损默认)",
    }),
});
export type ClarificationSkipBasisItem = z.infer<
  typeof ClarificationSkipBasisItemSchema
>;

/**
 * clarification/questions.json 模型 (design §6)。
 * simple 档可整段跳过 (questions=[] 且 can_proceed_with_defaults=True)。
 * 真实键 `schema` 默认 "loop-engineering.clarification.v2"。
 *
 * `skip_basis`: 裁量跳过澄清时的可审计留证 (medium/complex 无阻塞→空 questions 但须非空
 * skip_basis)。带默认 `[]` 是向后兼容的新增字段——旧 questions.json 缺它仍合法解析
 * (skip_basis=[]), 故 schema 版本仍为 v2。questions 非空时 skip_basis 通常为空 (有问题就不算跳过)。
 */
export const ClarificationQuestionsSchema = z.object({
  schema: z.string().default("loop-engineering.clarification.v2"),
  questions: z.array(QuestionSchema).default([]),
  skip_basis: z.array(ClarificationSkipBasisItemSchema).default([]),
  can_proceed_with_defaults: z.boolean().default(true),
});
export type ClarificationQuestions = z.infer<
  typeof ClarificationQuestionsSchema
>;

/**
 * clarification/answers.json 模型 (design §6)。
 * answers: question_id → 人答 / "采用默认"; 人不答则由 coordinator 写入 "采用默认"。
 * 真实键 `schema` 默认 "loop-engineering.clarification-answers.v1"。
 */
export const ClarificationAnswersSchema = z.object({
  schema: z.string().default("loop-engineering.clarification-answers.v1"),
  answers: z.record(z.string(), z.string()).default({}),
});
export type ClarificationAnswers = z.infer<typeof ClarificationAnswersSchema>;

/** 解析并校验 questions.json 数据 (对齐 Python `model_validate`)。 */
export function parseClarificationQuestions(
  data: unknown,
): ClarificationQuestions {
  return ClarificationQuestionsSchema.parse(data);
}

/** 解析并校验 answers.json 数据 (对齐 Python `model_validate`)。 */
export function parseClarificationAnswers(data: unknown): ClarificationAnswers {
  return ClarificationAnswersSchema.parse(data);
}
