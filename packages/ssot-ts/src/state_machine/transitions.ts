/**
 * Phase 级状态转换规则 (TS 版, 等价 Python `loop_engineering/state_machine/transitions.py`)。
 *
 * 规范源: design §1 (主流程) 与 §8.1 (任意 phase 可放弃)。
 *
 * 只管 run 级 phase 之间的合法迁移; 不跑调度、不解析 checks、不做 watchdog。
 * task 级状态 (pending/running/blocked/complete) 由 scheduling 模块维护, 不在此处。
 *
 * 与 Python 的差异处理:
 * - Python `frozenset[Phase]` → TS `ReadonlySet<Phase>` (`new Set([...])`), 语义等价。
 * - Python `model_copy(update=...)` (默认跳过 validator) → 此处构造新对象后用
 *   `RunStateSchema.parse` 重新校验, 行为更严, 但目标态均合法故等价 (ABORTED 写了
 *   aborted_at, 非 ABORTED 清空 aborted_at/aborted_reason, 都满足 superRefine)。
 * - Python `datetime.now(timezone.utc).isoformat()` → `new Date().toISOString()`
 *   (产出形如 `2026-06-27T10:00:00.000Z`, 可被 `Date(...)` / `Date.parse` 解析, 带时区 Z)。
 */
import { Phase, RunStateSchema } from "../schema/run_state.js";
import type { RunState } from "../schema/run_state.js";

/**
 * 非法 phase 迁移 (design §1)。
 *
 * 含 current / target / legalTargets 三字段, 便于上层诊断与 UI 提示。
 */
export class IllegalTransitionError extends Error {
  readonly current: Phase;
  readonly target: Phase;
  readonly legalTargets: ReadonlySet<Phase>;

  constructor(current: Phase, target: Phase, legalTargets: ReadonlySet<Phase>) {
    const sorted = [...legalTargets].sort();
    const targetsDesc = sorted.length > 0 ? JSON.stringify(sorted) : "<终态, 无后继>";
    super(`非法 phase 迁移: ${current} → ${target}; 合法目标仅 ${targetsDesc}`);
    this.name = "IllegalTransitionError";
    this.current = current;
    this.target = target;
    this.legalTargets = legalTargets;
    // 兼容 ES5 target 下的 instanceof
    Object.setPrototypeOf(this, IllegalTransitionError.prototype);
  }
}

/**
 * design §1 主流程 + §8.1 (任意 phase 可放弃)。
 * CREATED 可跳过 CLARIFYING 直接进 PLANNING (§1: CLARIFYING 可选)。
 */
export const LEGAL_TRANSITIONS: Readonly<Record<Phase, ReadonlySet<Phase>>> = {
  [Phase.CREATED]: new Set<Phase>([Phase.CLARIFYING, Phase.PLANNING, Phase.ABORTED]),
  [Phase.CLARIFYING]: new Set<Phase>([Phase.PLANNING, Phase.ABORTED]),
  // PLANNING 自环: plan-amendment 回到 PLANNING 重审 (§1)
  [Phase.PLANNING]: new Set<Phase>([Phase.IMPLEMENTING, Phase.PLANNING, Phase.ABORTED]),
  // 回 PLANNING: plan-amendment 改验收语义 (§1)
  [Phase.IMPLEMENTING]: new Set<Phase>([Phase.WRAPPING_UP, Phase.PLANNING, Phase.ABORTED]),
  // 集成测试红 → PLANNING; 就近返工 → IMPLEMENTING (§1)
  [Phase.WRAPPING_UP]: new Set<Phase>([
    Phase.COMPLETE,
    Phase.PLANNING,
    Phase.IMPLEMENTING,
    Phase.ABORTED,
  ]),
  // 终态, 不再推进 (§8 / §8.1)
  [Phase.COMPLETE]: new Set<Phase>(),
  [Phase.ABORTED]: new Set<Phase>(),
};

/** 查询 current → target 是否合法。 */
export function canTransition(current: Phase, target: Phase): boolean {
  const legal = LEGAL_TRANSITIONS[current] ?? new Set<Phase>();
  return legal.has(target);
}

/** 校验迁移, 不合法 throw IllegalTransitionError。 */
export function validateTransition(current: Phase, target: Phase): void {
  const legal = LEGAL_TRANSITIONS[current] ?? new Set<Phase>();
  if (!legal.has(target)) {
    throw new IllegalTransitionError(current, target, legal);
  }
}

/** 是否终态 (§8 / §8.1): COMPLETE 或 ABORTED, 进入后 run 不再推进。 */
export function isTerminal(phase: Phase): boolean {
  return phase === Phase.COMPLETE || phase === Phase.ABORTED;
}

/**
 * 推进 phase, 返回新 RunState 实例 (不可变风格)。
 *
 * - 校验 canTransition; 不通过 throw IllegalTransitionError。
 * - target == ABORTED: abortedReason 必填 (否则 Error); 写 aborted_at (UTC ISO 8601)。
 * - target != ABORTED: 防御性清空 aborted_at / aborted_reason (置 null)。
 *
 * @param state 当前状态。
 * @param target 目标 phase。
 * @param abortedReason 进 ABORTED 时的原因 (其它目标忽略)。
 */
export function advancePhase(
  state: RunState,
  target: Phase,
  abortedReason: string | null = null,
): RunState {
  validateTransition(state.phase, target);

  // 以原 state 为基底拷贝, 再覆盖 phase 与 aborted 字段。
  const updated: Record<string, unknown> = { ...state, phase: target };

  if (target === Phase.ABORTED) {
    // 空字符串也视为未提供 (与 Python `if not aborted_reason` 等价)。
    if (!abortedReason) {
      throw new Error("进入 ABORTED 必须给出 aborted_reason (design §8.1)");
    }
    updated.aborted_at = new Date().toISOString();
    updated.aborted_reason = abortedReason;
  } else {
    // 防御性: 非 ABORTED 时这两个字段必须为 null (superRefine 也会兜底)。
    updated.aborted_at = null;
    updated.aborted_reason = null;
  }

  // 重新校验 (等价 Pydantic 重建一致状态)。目标态均合法, 不会抛校验错。
  return RunStateSchema.parse(updated);
}
