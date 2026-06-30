/**
 * human_anchors.ts 等价测试 (P4-M2 go/no-go)。
 *
 * 行为权威: Python `tests/test_human_anchors.py` + `loop_engineering/state_machine/human_anchors.py`。
 * 被测实现: `packages/ssot-ts/src/state_machine/human_anchors.ts`。
 *
 * 逐条翻译 Python 用例: 三类 anchor 的合法 phase 矩阵、不可变、clear/query。
 */
import { test, expect } from "bun:test";
import {
  HumanPending,
  Phase,
  parseRunState,
} from "../../packages/ssot-ts/src/schema/run_state.js";
import type { RunState } from "../../packages/ssot-ts/src/schema/run_state.js";
import {
  InvalidHumanAnchorError,
  awaitingAnchor,
  clearHumanPending,
  isAwaitingHuman,
  setHumanPending,
} from "../../packages/ssot-ts/src/state_machine/human_anchors.js";

function make(phase: Phase): RunState {
  return parseRunState({ run_id: "r1", complexity: "simple", phase });
}

// ---------- clarification 锚点 (2026-06-30 回退为独立人锚点) ----------

test("HumanPending 含 clarification (回退: 阻塞性澄清问题独立停人)", () => {
  // 枚举含三个人盯点; clarification 仅在 CLARIFYING 阶段合法。
  expect(Object.values(HumanPending).sort()).toEqual([
    "clarification",
    "plan_signoff",
    "wrap_up_signoff",
  ]);
});

test("clarification 锚点 + CLARIFYING phase → 合法 (setHumanPending 不抛)", () => {
  const s = setHumanPending(make(Phase.CLARIFYING), HumanPending.clarification);
  expect(s.human_pending).toBe(HumanPending.clarification);
});

test("clarification 锚点 + PLANNING phase → 抛 InvalidHumanAnchorError", () => {
  expect(() =>
    setHumanPending(make(Phase.PLANNING), HumanPending.clarification),
  ).toThrow(InvalidHumanAnchorError);
});

test("clarification 锚点 + IMPLEMENTING/WRAPPING_UP/CREATED phase → 抛 InvalidHumanAnchorError", () => {
  for (const bad of [Phase.CREATED, Phase.IMPLEMENTING, Phase.WRAPPING_UP]) {
    expect(() =>
      setHumanPending(make(bad), HumanPending.clarification),
    ).toThrow(InvalidHumanAnchorError);
  }
});

// ---------- plan_signoff ----------

test("[py: test_set_plan_signoff_only_in_planning] plan_signoff 仅在 PLANNING 合法", () => {
  const s = setHumanPending(make(Phase.PLANNING), HumanPending.plan_signoff);
  expect(s.human_pending).toBe(HumanPending.plan_signoff);
  for (const bad of [Phase.CREATED, Phase.IMPLEMENTING, Phase.WRAPPING_UP]) {
    expect(() => setHumanPending(make(bad), HumanPending.plan_signoff)).toThrow(
      InvalidHumanAnchorError,
    );
  }
});

// ---------- wrap_up_signoff ----------

test("[py: test_set_wrap_up_signoff_only_in_wrapping_up] wrap_up_signoff 仅在 WRAPPING_UP 合法", () => {
  const s = setHumanPending(make(Phase.WRAPPING_UP), HumanPending.wrap_up_signoff);
  expect(s.human_pending).toBe(HumanPending.wrap_up_signoff);
  for (const bad of [Phase.CREATED, Phase.PLANNING, Phase.IMPLEMENTING, Phase.COMPLETE]) {
    expect(() => setHumanPending(make(bad), HumanPending.wrap_up_signoff)).toThrow(
      InvalidHumanAnchorError,
    );
  }
});

// ---------- 不可变 ----------

test("[py: test_set_human_pending_returns_new_instance] set 不修改原 state", () => {
  const state = make(Phase.PLANNING);
  const newState = setHumanPending(state, HumanPending.plan_signoff);
  expect(state.human_pending).toBeNull();
  expect(newState.human_pending).toBe(HumanPending.plan_signoff);
  expect(state).not.toBe(newState);
});

// ---------- clear / query ----------

test("[py: test_clear_human_pending] clear 返回 human_pending=null 的新 state", () => {
  const state = setHumanPending(make(Phase.PLANNING), HumanPending.plan_signoff);
  const cleared = clearHumanPending(state);
  expect(state.human_pending).toBe(HumanPending.plan_signoff); // 原不变
  expect(cleared.human_pending).toBeNull();
  expect(cleared).not.toBe(state);
});

test("[py: test_is_awaiting_human_true_when_set] is_awaiting_human 随 set/clear 变化", () => {
  const state = make(Phase.PLANNING);
  expect(isAwaitingHuman(state)).toBe(false);
  const waiting = setHumanPending(state, HumanPending.plan_signoff);
  expect(isAwaitingHuman(waiting)).toBe(true);
  const cleared = clearHumanPending(waiting);
  expect(isAwaitingHuman(cleared)).toBe(false);
});

test("[py: test_awaiting_anchor_returns_current] awaiting_anchor 返回当前 anchor", () => {
  const state = make(Phase.PLANNING);
  expect(awaitingAnchor(state)).toBeNull();
  const waiting = setHumanPending(state, HumanPending.plan_signoff);
  expect(awaitingAnchor(waiting)).toBe(HumanPending.plan_signoff);
});
