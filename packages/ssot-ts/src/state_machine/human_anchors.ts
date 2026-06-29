/**
 * 人介入锚点 (TS 版, 等价 Python `loop_engineering/state_machine/human_anchors.py`)。
 *
 * 规范源: design §1 与 §6。
 *
 * 两类合法人锚点: plan_signoff / wrap_up_signoff。wrap_up_signoff 是条件锚点, 仅异常/高风险收口时设置。
 * 状态机只校验 anchor 与当前 phase 的合法性, 不负责通知或超时。
 *
 * 与 Python 的差异处理:
 * - `model_copy(update=...)` → 此处构造新对象后用 `RunStateSchema.parse` 重新校验,
 *   set 时 phase 不变且合法故等价 (clear 时同理)。
 * - `frozenset[Phase]` → `ReadonlySet<Phase>`。
 */
import { HumanPending, Phase, RunStateSchema } from "../schema/run_state.js";
import type { HumanPending as HumanPendingType, RunState } from "../schema/run_state.js";

/**
 * anchor 与当前 phase 不匹配 (design §1)。
 *
 * 含 phase / anchor 两字段, 便于上层定位。
 */
export class InvalidHumanAnchorError extends Error {
  readonly phase: Phase;
  readonly anchor: HumanPendingType;

  constructor(phase: Phase, anchor: HumanPendingType) {
    super(`anchor=${anchor} 在 phase=${phase} 下不合法 (design §1)`);
    this.name = "InvalidHumanAnchorError";
    this.phase = phase;
    this.anchor = anchor;
    Object.setPrototypeOf(this, InvalidHumanAnchorError.prototype);
  }
}

/**
 * design §1: 每个 anchor 只在特定 phase 合法。
 * 方法论演进 (2026-06-28): 删除 clarification 锚点; wrap_up_signoff 从必经锚点改为条件锚点。
 */
const ANCHOR_ALLOWED_PHASES: Readonly<Record<HumanPendingType, ReadonlySet<Phase>>> = {
  [HumanPending.plan_signoff]: new Set<Phase>([Phase.PLANNING]),
  [HumanPending.wrap_up_signoff]: new Set<Phase>([Phase.WRAPPING_UP]),
};

function validateAnchor(phase: Phase, anchor: HumanPendingType): void {
  const allowed = ANCHOR_ALLOWED_PHASES[anchor] ?? new Set<Phase>();
  if (!allowed.has(phase)) {
    throw new InvalidHumanAnchorError(phase, anchor);
  }
}

/**
 * 返回设置了 human_pending=anchor 的新 state。
 *
 * 校验 anchor 与 phase 合法性, 不合法 throw InvalidHumanAnchorError。
 */
export function setHumanPending(state: RunState, anchor: HumanPendingType): RunState {
  validateAnchor(state.phase, anchor);
  return RunStateSchema.parse({ ...state, human_pending: anchor });
}

/** 返回 human_pending=null 的新 state。 */
export function clearHumanPending(state: RunState): RunState {
  return RunStateSchema.parse({ ...state, human_pending: null });
}

/** 是否正在等人。 */
export function isAwaitingHuman(state: RunState): boolean {
  return state.human_pending !== null && state.human_pending !== undefined;
}

/** 返回当前 anchor, 没有则 null。 */
export function awaitingAnchor(state: RunState): HumanPendingType | null {
  return state.human_pending ?? null;
}
