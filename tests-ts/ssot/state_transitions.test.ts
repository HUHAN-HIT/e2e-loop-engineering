/**
 * transitions.ts 等价测试 (P4-M2 go/no-go)。
 *
 * 行为权威: Python `tests/test_state_transitions.py` + `loop_engineering/state_machine/transitions.py`。
 * 被测实现: `packages/ssot-ts/src/state_machine/transitions.ts`。
 *
 * 逐条翻译 Python 用例: LEGAL_TRANSITIONS 图覆盖、ABORTED 规则、非法迁移、advancePhase 不可变。
 * 导入用相对路径到子包文件 (本里程不改 index.ts)。
 */
import { test, expect } from "bun:test";
import { Phase, parseRunState } from "../../packages/ssot-ts/src/schema/run_state.js";
import type { RunState } from "../../packages/ssot-ts/src/schema/run_state.js";
import {
  LEGAL_TRANSITIONS,
  IllegalTransitionError,
  advancePhase,
  canTransition,
  isTerminal,
  validateTransition,
} from "../../packages/ssot-ts/src/state_machine/transitions.js";

// ---------- 辅助 ----------

function make(phase: Phase = Phase.CREATED): RunState {
  return parseRunState({ run_id: "r1", complexity: "simple", phase });
}

const ALL_PHASES: Phase[] = [
  Phase.CREATED,
  Phase.CLARIFYING,
  Phase.PLANNING,
  Phase.IMPLEMENTING,
  Phase.WRAPPING_UP,
  Phase.COMPLETE,
  Phase.ABORTED,
];

const NON_TERMINAL: Phase[] = [
  Phase.CREATED,
  Phase.CLARIFYING,
  Phase.PLANNING,
  Phase.IMPLEMENTING,
  Phase.WRAPPING_UP,
];

// ---------- graph 覆盖 ----------

test("[py: test_legal_transitions_complete_graph] LEGAL_TRANSITIONS 覆盖全部 7 个 Phase", () => {
  expect(new Set(Object.keys(LEGAL_TRANSITIONS))).toEqual(new Set(ALL_PHASES));
});

test("[py: test_every_non_terminal_can_abort] 5 个非终态都能转 ABORTED (§8.1)", () => {
  for (const p of NON_TERMINAL) {
    expect(LEGAL_TRANSITIONS[p].has(Phase.ABORTED)).toBe(true);
  }
});

test("[py: test_terminal_phases_have_no_outgoing] COMPLETE / ABORTED 无后继", () => {
  expect(LEGAL_TRANSITIONS[Phase.COMPLETE].size).toBe(0);
  expect(LEGAL_TRANSITIONS[Phase.ABORTED].size).toBe(0);
});

test("[py: test_clarifying_can_be_skipped] CREATED → PLANNING 直接合法 (§1)", () => {
  expect(canTransition(Phase.CREATED, Phase.PLANNING)).toBe(true);
});

test("[py: test_planning_self_loop] PLANNING → PLANNING 合法 (plan-amendment 重审, §1)", () => {
  expect(canTransition(Phase.PLANNING, Phase.PLANNING)).toBe(true);
});

// ---------- 非法迁移 ----------

test("[py: test_illegal_transition_raises] 终态后任何迁移都非法", () => {
  for (const terminal of [Phase.COMPLETE, Phase.ABORTED]) {
    for (const target of ALL_PHASES) {
      let caught: unknown;
      try {
        validateTransition(terminal, target);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(IllegalTransitionError);
      const err = caught as IllegalTransitionError;
      expect(err.current).toBe(terminal);
      expect(err.target).toBe(target);
      expect(err.legalTargets.size).toBe(0);
    }
  }
});

test("[py: test_illegal_transition_created_to_wrapping] 跨阶段跳迁非法", () => {
  expect(() => validateTransition(Phase.CREATED, Phase.WRAPPING_UP)).toThrow(
    IllegalTransitionError,
  );
});

// ---------- advancePhase ----------

test("[py: test_advance_phase_returns_new_instance] advance 不修改原 state", () => {
  const state = make(Phase.CREATED);
  const originalPhase = state.phase;
  const newState = advancePhase(state, Phase.CLARIFYING);
  expect(state.phase).toBe(originalPhase);
  expect(state).not.toBe(newState);
  expect(newState.phase).toBe(Phase.CLARIFYING);
});

test("[py: test_advance_to_aborted_sets_timestamp] 进 ABORTED 写 ISO 8601 非空时间戳", () => {
  const state = make(Phase.CREATED);
  const newState = advancePhase(state, Phase.ABORTED, "用户放弃");
  expect(newState.phase).toBe(Phase.ABORTED);
  expect(newState.aborted_at).not.toBeNull();
  // ISO 8601 可被 Date 解析, 且带时区 (toISOString 始终以 Z 结尾)
  const ts = new Date(newState.aborted_at as string);
  expect(Number.isNaN(ts.getTime())).toBe(false);
  expect((newState.aborted_at as string).endsWith("Z")).toBe(true);
  expect(newState.aborted_reason).toBe("用户放弃");
});

test("[py: test_advance_to_aborted_requires_reason] 进 ABORTED 必须给 reason (§8.1)", () => {
  const state = make(Phase.CREATED);
  expect(() => advancePhase(state, Phase.ABORTED, null)).toThrow();
  // 空字符串也视为未提供
  expect(() => advancePhase(state, Phase.ABORTED, "")).toThrow();
});

test("[py: test_advance_to_aborted_from_every_phase] 5 个非终态都能转 ABORTED", () => {
  for (const p of NON_TERMINAL) {
    const state = make(p);
    const newState = advancePhase(state, Phase.ABORTED, "放弃");
    expect(newState.phase).toBe(Phase.ABORTED);
    expect(newState.aborted_at).not.toBeNull();
  }
});

test("[py: test_advance_clears_aborted_fields_on_non_aborted] 进非 ABORTED 清空 aborted 字段", () => {
  const state = make(Phase.CREATED);
  const newState = advancePhase(state, Phase.PLANNING);
  expect(newState.aborted_at).toBeNull();
  expect(newState.aborted_reason).toBeNull();
});

test("[py: test_advance_illegal_raises] advance 内部 validate, 非法时抛", () => {
  const state = make(Phase.COMPLETE);
  expect(() => advancePhase(state, Phase.PLANNING)).toThrow(IllegalTransitionError);
});

// ---------- isTerminal ----------

test("[py: test_is_terminal] COMPLETE/ABORTED 为终态, 其余非终态", () => {
  expect(isTerminal(Phase.COMPLETE)).toBe(true);
  expect(isTerminal(Phase.ABORTED)).toBe(true);
  for (const p of NON_TERMINAL) {
    expect(isTerminal(p)).toBe(false);
  }
});
