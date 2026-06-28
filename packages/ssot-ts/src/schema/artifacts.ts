/**
 * worker 产物 schema (zod 版, 等价 Python `loop_engineering/schema/artifacts.py`)。
 *
 * 规范源: design §0.2 (worker 自报告软约束)、§0.4 (artifact-first)、
 * §2.3 (key-diffs.yaml 分级)、§3.1 (test-results.yaml 固定字段)、§3.6 (plan-amendment)。
 *
 * 关键约束: test-results 用 `.strict()` (≈ Pydantic extra="forbid") 强制 worker 不得自创字段 (§3.1)。
 *
 * 与 Pydantic 的差异处理:
 * - `extra="forbid"` → zod `.strict()` (多余键直接报错)。
 * - `TestResults` 的一致性校验是**软约束** (Pydantic 用 warnings.warn 不 raise);
 *   zod `.superRefine` 不支持"只告警不失败", 故在校验回调里 `console.warn` 且不 addIssue,
 *   与 Python 端 "warn 但通过" 行为等价 (测试通过捕获 console.warn 观察)。
 * - `KeyDiffsFile.is_meaningful()` 是实例方法; zod 产出纯对象无方法, 改为独立函数 `isMeaningful(file)`。
 * - `PlanAmendmentNeeded.touched_acceptance_refs` 非空硬校验 → `.array(...).min(1)` (raise)。
 * - `status: Literal[...]` 默认值 → `z.literal(...).default(...)`。
 */
import { z } from "zod";

// ---------------- test-results ----------------

/**
 * worker 跑单测后某个 case 的结果 (design §3.1)。
 * `.strict()` 强制: worker 不得自创字段去迎合某条 checks
 * (那等于让被测方定义判定口径, hallucination 落点)。
 */
export const TestCaseResultSchema = z
  .object({
    id: z.string(),
    passed: z.boolean(),
    failure_reason: z.string().default(""),
  })
  .strict();
export type TestCaseResult = z.infer<typeof TestCaseResultSchema>;

/**
 * test-results.yaml 模型 (design §3.1)。
 * `.strict()`: worker 不得自创字段。
 * tests_green 是 worker 自报告的总开关, 与 cases.passed 一致性是软约束
 * (design §0.2: 自报告被接受, hallucination 兜底靠收口 diff, 不在 schema 强制)。
 */
export const TestResultsSchema = z
  .object({
    tests_green: z.boolean(),
    cases: z.array(TestCaseResultSchema),
  })
  .strict()
  .superRefine((tr) => {
    // tests_green 与 cases.passed 不一致时告警但不失败 (软约束, 等价 Python warnings.warn)。
    if (tr.cases.length > 0) {
      const consistent = tr.tests_green === tr.cases.every((c) => c.passed);
      if (!consistent) {
        // eslint-disable-next-line no-console
        console.warn(
          `test-results.yaml: tests_green=${tr.tests_green} 与 cases.passed 不一致 ` +
            "(design §0.2 软约束, worker 自报告)",
        );
      }
    }
  });
export type TestResults = z.infer<typeof TestResultsSchema>;

// ---------------- key-diffs ----------------

/**
 * 单条关键改动 (design §2.3)。
 * risk 这里是 worker 自由文本描述该条改动的风险点, 区别于 task.risk (枚举)。
 */
export const KeyDiffEntrySchema = z.object({
  file: z.string(),
  change: z.string(),
  why: z.string(),
  risk: z.string(),
});
export type KeyDiffEntry = z.infer<typeof KeyDiffEntrySchema>;

/**
 * key-diffs.yaml 模型 (design §2.3, §6)。
 * risk:high / exclusive task 收口前必填非空 (§2.3); 非空判定用 `isMeaningful()`。
 * 真实键 `schema` 默认 "loop-engineering.key-diffs.v1"。
 */
export const KeyDiffsFileSchema = z.object({
  schema: z.string().default("loop-engineering.key-diffs.v1"),
  task_id: z.string(),
  key_diffs: z.array(KeyDiffEntrySchema).default([]),
});
export type KeyDiffsFile = z.infer<typeof KeyDiffsFileSchema>;

/** 是否非空 (design §2.3: risk:high/exclusive task 的 key_diffs 必填非空)。 */
export function isMeaningful(file: KeyDiffsFile): boolean {
  return file.key_diffs.length > 0;
}

// ---------------- plan-amendment ----------------

/**
 * plan-amendment 信号 (design §3.6)。
 * worker 发现某 planned 用例不可执行或本身错了, 返回此结构。
 * touched_acceptance_refs 必须非空 (amendment 必须声明触及的 AC)。
 */
export const PlanAmendmentNeededSchema = z.object({
  status: z.literal("plan-amendment-needed").default("plan-amendment-needed"),
  reason: z.string(),
  touched_acceptance_refs: z
    .array(z.string())
    .min(1, "touched_acceptance_refs 不得为空 (design §3.6: amendment 必须声明触及的 AC)"),
});
export type PlanAmendmentNeeded = z.infer<typeof PlanAmendmentNeededSchema>;

// ---------------- contract-change ----------------

/**
 * worker 在 summary 里声明的契约变更引用 (design §11.2 第 2 层)。
 * 辅助及早信号; 与权威触发源 (service-contracts.yaml 版本 diff) 不一致时以权威为准 + 告警。
 */
export const ContractChangeSchema = z.object({
  name: z.string(),
});
export type ContractChange = z.infer<typeof ContractChangeSchema>;
