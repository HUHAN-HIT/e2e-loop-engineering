/**
 * §5 trust_mode 切档 gate 等价测试 (P4-M6 go/no-go)。
 *
 * 行为权威: Python `tests/test_trust_mode_gate.py` + `loop_engineering/trust_mode/gate.py`。
 * 被测实现: `packages/ssot-ts/src/trust_mode/gate.ts`。
 *
 * 逐条翻译 Python 用例: probe 默认未就绪、降档恒允许且不改原 state、
 * 升档未就绪被拒、注入 ready 后升档成功、返回新实例不变更原 state。
 *
 * 说明: Python 测试用 monkeypatch 替换 `probe_unattended_readiness`; TS/ESM 下改为
 * 向 `switchTrustMode` 注入 `probe` 参数 (见 gate.ts 文档), 语义等价。
 */
import { test, expect, describe } from "bun:test";
import { Complexity, TrustMode, parseRunState, type RunState } from "@e2e-loop/ssot";
import {
  TrustModeSwitchRefused,
  canSwitchToUnattended,
  probeUnattendedReadiness,
  switchTrustMode,
  type UnattendedReadiness,
} from "../../packages/ssot-ts/src/trust_mode/gate.js";

// 对齐 Python `_mk_state`: run_id=r1, complexity=medium, 指定 trust_mode。
function mkState(mode: string = TrustMode.collaborative): RunState {
  return parseRunState({
    run_id: "r1",
    complexity: Complexity.medium,
    trust_mode: mode,
  });
}

// 注入用的"已就绪" probe (等价 Python monkeypatch 返回 ready 的 UnattendedReadiness)。
const readyProbe = (): UnattendedReadiness => ({
  independentReplayChannelReady: true,
  reasons: [],
});

describe("TestProbe", () => {
  test("[py: test_default_returns_false] probe 默认返回未就绪, reasons 非空", () => {
    const r = probeUnattendedReadiness();
    expect(r.independentReplayChannelReady).toBe(false);
    expect(r.reasons.length).toBeGreaterThan(0); // 非空
  });

  test("[py: test_can_switch_to_unattended_false_by_default] 默认不可切 unattended", () => {
    const r = probeUnattendedReadiness();
    expect(canSwitchToUnattended(r)).toBe(false);
  });
});

describe("TestSwitchToCollaborative", () => {
  test("[py: test_always_allowed_from_unattended] 从 unattended 降档恒允许, 不改原 state", () => {
    const state = mkState(TrustMode.unattended);
    const newState = switchTrustMode(state, TrustMode.collaborative);
    expect(newState.trust_mode).toBe(TrustMode.collaborative);
    // 原状态未变
    expect(state.trust_mode).toBe(TrustMode.unattended);
  });

  test("[py: test_idempotent] collaborative → collaborative 幂等", () => {
    const state = mkState(TrustMode.collaborative);
    const newState = switchTrustMode(state, TrustMode.collaborative);
    expect(newState.trust_mode).toBe(TrustMode.collaborative);
  });
});

describe("TestSwitchToUnattended", () => {
  test("[py: test_refused_when_not_ready] 未就绪时升档被拒, target/reasons 正确", () => {
    const state = mkState(TrustMode.collaborative);
    let caught: unknown;
    try {
      switchTrustMode(state, TrustMode.unattended);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TrustModeSwitchRefused);
    const err = caught as TrustModeSwitchRefused;
    expect(err.target).toBe(TrustMode.unattended);
    expect(err.reasons.length).toBeGreaterThan(0); // 非空
  });

  test("[py: test_allowed_when_ready] 注入 ready probe 后升档成功", () => {
    const state = mkState(TrustMode.collaborative);
    const newState = switchTrustMode(state, TrustMode.unattended, readyProbe);
    expect(newState.trust_mode).toBe(TrustMode.unattended);
  });

  test("[py: test_returns_new_instance_not_mutating_original] 返回新实例, 不变更原 state", () => {
    const state = mkState(TrustMode.collaborative);
    const newState = switchTrustMode(state, TrustMode.unattended, readyProbe);
    expect(newState).not.toBe(state);
    expect(state.trust_mode).toBe(TrustMode.collaborative); // 原未改
    expect(newState.trust_mode).toBe(TrustMode.unattended);
  });
});
