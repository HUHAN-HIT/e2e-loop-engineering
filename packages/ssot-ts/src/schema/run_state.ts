/**
 * Run 级状态模型 (zod 版, 等价 Python `loop_engineering/schema/run_state.py`)。
 *
 * 规范源: design §6 (Run 目录与 Schema)、§3.3 (watchdog 阈值)、§3.4 (capabilities 探测)、
 * §8.1 (ABORTED 语义)。
 *
 * run-state.json 是 run 的单一活动状态源, 由 coordinator 单写者维护。
 *
 * 与 Pydantic 的差异处理:
 * - Pydantic StrEnum → zod `z.enum([...])`; 额外导出同名常量对象 (如 `Phase.CREATED`) 保留
 *   Python 端的访问写法。枚举值与 design §6 字面量一一对应。
 * - Pydantic `model_validator(mode="after")` 的 ABORTED 一致性交叉校验 → zod `.superRefine`。
 * - 嵌套默认值 (RunConfig() / WatchdogTimeouts()) → 对应 schema 的 `.default(...)`,
 *   行为与 Pydantic 默认实例化等价。
 * - Pydantic 默认 extra="ignore" (丢弃多余字段) ↔ zod 默认 `.strip()`, 二者一致, 不显式标注。
 */
import { z } from "zod";

// ---------------- 枚举 ----------------

/**
 * run 级 phase (design §6 / §1 / §8.1)。
 * CREATED → CLARIFYING(可选) → PLANNING → IMPLEMENTING → WRAPPING_UP → COMPLETE
 * 任意 phase 均可由人显式放弃 → ABORTED。
 */
export const Phase = {
  CREATED: "CREATED",
  CLARIFYING: "CLARIFYING",
  PLANNING: "PLANNING",
  IMPLEMENTING: "IMPLEMENTING",
  WRAPPING_UP: "WRAPPING_UP",
  COMPLETE: "COMPLETE",
  ABORTED: "ABORTED",
} as const;
export const PhaseSchema = z.enum([
  "CREATED",
  "CLARIFYING",
  "PLANNING",
  "IMPLEMENTING",
  "WRAPPING_UP",
  "COMPLETE",
  "ABORTED",
]);
export type Phase = z.infer<typeof PhaseSchema>;

/** 复杂度档位 (design §1.1), 决定摩擦预算而非单个 task 内部实现。 */
export const Complexity = {
  simple: "simple",
  medium: "medium",
  complex: "complex",
} as const;
export const ComplexitySchema = z.enum(["simple", "medium", "complex"]);
export type Complexity = z.infer<typeof ComplexitySchema>;

/**
 * 信任档位 (design §5)。
 * collaborative (默认): 人盯计划与收口。
 * unattended: 无人值守, 启用独立复跑通道 (§0.3 保留, MVP 未实现)。
 */
export const TrustMode = {
  collaborative: "collaborative",
  unattended: "unattended",
} as const;
export const TrustModeSchema = z.enum(["collaborative", "unattended"]);
export type TrustMode = z.infer<typeof TrustModeSchema>;

/**
 * 人介入时机 (design §1, §6)。
 * null 表示无需人介入, 系统自动推进; 两类非空值分别对应两个人盯点。
 *
 * 注: 历史上曾有第三个值 `clarification` (澄清独立停顿)。方法论演进 (2026-06-28):
 * 澄清不再单独停人——带默认直进 PLANNING, 问题在 plan 签署时一并呈现, 故删除该锚点。
 * (此处 TS 已不再与归档 Python 的 HumanPending 等价, 是有意的演进而非端口缺陷。)
 */
export const HumanPending = {
  plan_signoff: "plan_signoff",
  wrap_up_signoff: "wrap_up_signoff",
} as const;
export const HumanPendingSchema = z.enum(["plan_signoff", "wrap_up_signoff"]);
export type HumanPending = z.infer<typeof HumanPendingSchema>;

// ---------------- 嵌套模型 ----------------

/**
 * 宿主能力探测结果 (design §3.4)。
 * CREATED 时由 coordinator 一次性探测写入, 决定 actual_writes 走独立采集还是回退 worker 自报。
 * 不预设 True, 以探测结果为准。
 */
export const RunCapabilitiesSchema = z.object({
  git_diff: z.boolean().default(false),
  fs_snapshot: z.boolean().default(false),
});
export type RunCapabilities = z.infer<typeof RunCapabilitiesSchema>;

/**
 * 各复杂度档位的 watchdog 超时分钟数 (design §3.3)。
 * complex task 正常耗时更长, 阈值更宽, 避免把正常 worker 误判失联反复重派。
 */
export const WatchdogTimeoutsSchema = z.object({
  simple: z.number().int().default(15),
  medium: z.number().int().default(30),
  complex: z.number().int().default(60),
});
export type WatchdogTimeouts = z.infer<typeof WatchdogTimeoutsSchema>;

/** 运行参数的单一落点 (design §6), 供 watchdog 与调度引用, 改阈值只改这里。 */
export const RunConfigSchema = z.object({
  watchdog_timeout_min: WatchdogTimeoutsSchema.default({}),
  max_retries_per_task: z.number().int().default(1),
  max_concurrency: z.number().int().default(4),
});
export type RunConfig = z.infer<typeof RunConfigSchema>;

// ---------------- 顶层模型 ----------------

/**
 * run-state.json 的极简 schema (design §6)。
 * 核心字段 + 两个可选机制字段 (capabilities / config)。ABORTED 时附加 aborted_at / aborted_reason。
 *
 * `.superRefine` 复刻 Python `_check_aborted_consistency`:
 * - phase == ABORTED 时 aborted_at 必须非 None;
 * - phase != ABORTED 时 aborted_at 与 aborted_reason 必须为 None (避免误导)。
 */
export const RunStateSchema = z
  .object({
    run_id: z.string(),
    phase: PhaseSchema.default("CREATED"),
    complexity: ComplexitySchema,
    trust_mode: TrustModeSchema.default("collaborative"),
    human_pending: HumanPendingSchema.nullish().default(null),
    active_tasks: z.array(z.string()).default([]),
    key_artifacts: z.array(z.string()).default([]),
    capabilities: RunCapabilitiesSchema.nullish().default(null),
    workdir: z.string().nullish().default(null),
    worktree_binding_path: z.string().nullish().default(null),
    config: RunConfigSchema.default({}),
    aborted_at: z.string().nullish().default(null),
    aborted_reason: z.string().nullish().default(null),
  })
  .superRefine((rs, ctx) => {
    if (rs.phase === "ABORTED") {
      if (rs.aborted_at === null || rs.aborted_at === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["aborted_at"],
          message: "phase == ABORTED 时 aborted_at 必须非 None (design §8.1)",
        });
      }
    } else {
      if (
        (rs.aborted_at !== null && rs.aborted_at !== undefined) ||
        (rs.aborted_reason !== null && rs.aborted_reason !== undefined)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["aborted_at"],
          message:
            "phase != ABORTED 时 aborted_at 与 aborted_reason 必须为 None " +
            "(design §6: 其它 phase 下这两个字段不出现在文件里, 避免误导)",
        });
      }
    }
  });
export type RunState = z.infer<typeof RunStateSchema>;

/**
 * 解析并校验 run-state 数据 (对齐 Python `RunState.model_validate`)。
 * 校验失败抛 `ZodError`。
 */
export function parseRunState(data: unknown): RunState {
  return RunStateSchema.parse(data);
}
