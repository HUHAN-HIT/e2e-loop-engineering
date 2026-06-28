/**
 * §5 trust_mode 切档 gate (TS 版, 等价 Python `loop_engineering/trust_mode/gate.py`)。
 *
 * 规范源: design §5 (信任档位) + §0.3 (独立复跑通道保留, MVP 未实现)。
 *
 * 核心契约: 切到 unattended 前必须 probe, 不就绪就拒绝 (TrustModeSwitchRefused)。
 * 拒绝静默降级 —— "默默从 unattended 退回 collaborative" 是不可接受的, 必须显式 throw。
 * MVP 默认 unattended 通道未建, probe 返回 false。
 *
 * 与 Python 的差异处理:
 * - Python `@dataclass(frozen=True)` UnattendedReadiness → TS interface (纯数据结构)。
 * - Python `RunState.model_copy(update={...})` 返回新校验实例 → TS 侧用
 *   `RunStateSchema.parse({ ...state, trust_mode })` 复刻: 返回新对象、不修改原 state、
 *   且经过 zod 重新校验 (与 Pydantic model_copy 后仍是合法模型一致)。
 * - Python `probe_unattended_readiness` 是模块级函数, 测试用 monkeypatch 替换。TS/ESM 下
 *   模块内部对自身导出函数的直接调用无法被 monkeypatch 拦截 (live binding 仍指向原声明),
 *   因此 `switchTrustMode` 增设可选参数 `probe` (默认 `probeUnattendedReadiness`) 做依赖注入,
 *   忠实复刻 Python "替换 probe 返回 ready" 的测试意图, 而不改变生产路径默认行为。
 */
import {
  RunStateSchema,
  TrustMode,
  type RunState,
  type TrustMode as TrustModeType,
} from "../schema/run_state.js";

/**
 * unattended 档的就绪状态探测结果。
 *
 * - independentReplayChannelReady: §0.3 保留的独立复跑通道是否建好。MVP 未实现, 默认 false。
 * - reasons: 未就绪的诊断 (空数组 = 已就绪)。
 */
export interface UnattendedReadiness {
  independentReplayChannelReady: boolean;
  reasons: string[];
}

/**
 * 探测独立复跑通道是否就绪。
 *
 * MVP 实现: 默认 false, reason 提示通道未建。真实探测留给后续
 * (检测 capability flag / 入口文件存在等)。
 */
export function probeUnattendedReadiness(): UnattendedReadiness {
  return {
    independentReplayChannelReady: false,
    reasons: ["独立复跑通道未建 (§0.3 保留, §7 MVP 未实现)"],
  };
}

/** ready → true; 否则 false。 */
export function canSwitchToUnattended(readiness: UnattendedReadiness): boolean {
  return readiness.independentReplayChannelReady;
}

/**
 * 切档被拒。
 *
 * - target: 被拒绝切往的目标档位。
 * - reasons: 拒绝原因列表 (来自 readiness.reasons)。
 */
export class TrustModeSwitchRefused extends Error {
  readonly target: TrustModeType;
  readonly reasons: string[];

  constructor(target: TrustModeType, reasons: string[]) {
    const copied = [...reasons];
    super(`trust_mode 切到 '${target}' 被拒: ${JSON.stringify(copied)}`);
    // 维持原型链 (TS 编译到 ES5/ES2022 下 extends Error 的常规处理)。
    Object.setPrototypeOf(this, TrustModeSwitchRefused.prototype);
    this.name = "TrustModeSwitchRefused";
    this.target = target;
    this.reasons = copied;
  }
}

/**
 * 切档入口 (返回新 RunState, 不修改原 state)。
 *
 * @param state 当前 RunState。
 * @param target 目标档位。
 * @param probe 就绪探测器 (默认 `probeUnattendedReadiness`); 测试可注入 ready 版本,
 *   等价 Python 测试对 `probe_unattended_readiness` 的 monkeypatch。
 * @returns 新 RunState (trust_mode 更新, 经 RunStateSchema 重新校验)。
 * @throws {TrustModeSwitchRefused} target=unattended 且 readiness 未就绪。
 */
export function switchTrustMode(
  state: RunState,
  target: TrustModeType,
  probe: () => UnattendedReadiness = probeUnattendedReadiness,
): RunState {
  if (target === TrustMode.collaborative) {
    // 降档永远允许 (无 gate)。
    return RunStateSchema.parse({
      ...state,
      trust_mode: TrustMode.collaborative,
    });
  }

  if (target === TrustMode.unattended) {
    const readiness = probe();
    if (!canSwitchToUnattended(readiness)) {
      throw new TrustModeSwitchRefused(target, [...readiness.reasons]);
    }
    return RunStateSchema.parse({
      ...state,
      trust_mode: TrustMode.unattended,
    });
  }

  // 兜底: 未知档位 (TrustModeSchema 约束下不会走到这里)。
  throw new TrustModeSwitchRefused(target, [`未知 trust_mode: ${String(target)}`]);
}
