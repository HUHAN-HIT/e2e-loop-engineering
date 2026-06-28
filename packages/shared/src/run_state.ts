/**
 * RunState 类型定义 (规范源: design §6, 与 Python `schema/run_state.py` 对齐)。
 *
 * 与 Python 端字段一一对应; ABORTED 一致性校验由 Python SSOT 负责, TS 这边只在 hook
 * 读取时容忍任意 phase 值 (probe_and_gate 异常退化放行)。
 */

/** run 级 phase (design §6 / §1 / §8.1) */
export type Phase =
  | "CREATED"
  | "CLARIFYING"
  | "PLANNING"
  | "IMPLEMENTING"
  | "WRAPPING_UP"
  | "COMPLETE"
  | "ABORTED";

/** 终态集合 (findActiveRun 跳过) */
export const TERMINAL_PHASES: ReadonlySet<Phase> = new Set([
  "COMPLETE",
  "ABORTED",
]);

/** 复杂度档位 (design §1.1) */
export type Complexity = "simple" | "medium" | "complex";

/** 信任档位 (design §5) */
export type TrustMode = "collaborative" | "unattended";

/** 人介入时机 (design §1, §6); null 表示无需人介入 */
export type HumanPending =
  | "clarification"
  | "plan_signoff"
  | "wrap_up_signoff"
  | null;

/** 宿主能力探测结果 (design §3.4) */
export interface RunCapabilities {
  git_diff: boolean;
  fs_snapshot: boolean;
}

/** watchdog 各档位超时分钟数 (design §3.3) */
export interface WatchdogTimeouts {
  simple: number;
  medium: number;
  complex: number;
}

/** run 运行参数 (design §6) */
export interface RunConfig {
  watchdog_timeout_min: WatchdogTimeouts;
  max_retries_per_task: number;
  max_concurrency: number;
}

/** run-state.json 的 schema (design §6) */
export interface RunState {
  run_id: string;
  phase: Phase;
  complexity: Complexity;
  trust_mode: TrustMode;
  human_pending?: HumanPending;
  active_tasks: string[];
  key_artifacts?: string[];
  capabilities?: RunCapabilities | null;
  config?: RunConfig;
  aborted_at?: string | null;
  aborted_reason?: string | null;
}

/**
 * 手写 type guard: 判定任意值是否是合法 RunState (zod-free)。
 *
 * 只校验关键字段存在与基础类型, 不做 ABORTED 一致性 (那是 Python SSOT 的事)。
 */
export function isRunState(value: unknown): value is RunState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.run_id === "string" &&
    typeof v.phase === "string" &&
    typeof v.complexity === "string" &&
    typeof v.trust_mode === "string" &&
    (v.active_tasks === undefined || Array.isArray(v.active_tasks))
  );
}
