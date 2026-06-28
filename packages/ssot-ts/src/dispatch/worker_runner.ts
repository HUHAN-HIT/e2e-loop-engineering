/**
 * WorkerRunner 抽象 (design master-prompt §3 运行模式自适应)。
 *
 * 行为权威: Python `loop_engineering/dispatch/worker_runner.py`。
 * 规范源: master-prompt §3 —— WorkerRunner 有两形态:
 * - 真实形态 (Claude Code subagent 隔离): 由宿主提供, MVP 不实现具体。
 * - 兜底形态 (单上下文 / 测试): 同进程内 dry-run "扮演" worker, InlineWorkerRunner +
 *   RecordingWorkerRunner —— 不打真实 LLM, 是 dry-run echo 占位实现。
 *
 * WorkerOutcome 是 worker 跑完的回收结果三态 (completed / plan_amendment / failed),
 * 对应 design §3.6 (plan_amendment) 与 §2.2 (任务自检的输入)。
 *
 * 与 Python 的差异处理:
 * - dataclass(frozen=True) → readonly 接口 + 工厂函数 makeWorkerOutcome (补默认值,
 *   等价 Python dataclass 默认值 + default_factory)。
 * - ABC + @abstractmethod → TS interface (鸭子类型, dispatch 是同步阻塞调用)。
 * - datetime(UTC) → JS Date。
 */
import type {
  KeyDiffsFile,
  PlanAmendmentNeeded,
  TestResults,
} from "../schema/artifacts.js";
import type { WorkerPacket } from "./packet.js";

/** WorkerOutcome 三态 (design §3.6 + §2.2)。 */
export type WorkerStatus = "completed" | "plan_amendment" | "failed";

/**
 * worker 跑完的回收结果。三态 (design §3.6 + §2.2)。
 *
 * status=completed: 正常完成, testResults 给出测试结果。
 * status=plan_amendment: worker 发现 planned 用例不可执行或本身错了, 返回 planAmendment。
 * status=failed: worker 报告自己跑挂了 (crash / 内部错误), failureReason 描述原因。
 */
export interface WorkerOutcome {
  /** 三态之一。 */
  readonly status: WorkerStatus;
  /** status=completed 时由 worker 交回的 test-results.yaml 解析结果。 */
  readonly test_results: TestResults | null;
  /** worker 写到 summary.md 的内容 (或路径, MVP 用内联文本)。 */
  readonly summary_text: string;
  /** status=completed 时可附带的 key-diffs.yaml (null = 未提交)。 */
  readonly key_diffs_file: KeyDiffsFile | null;
  /** status=plan_amendment 时必填。 */
  readonly plan_amendment: PlanAmendmentNeeded | null;
  /** status=failed 时的失败原因。 */
  readonly failure_reason: string;
  /** 用于诊断与 watchdog 的辅助时间戳 (UTC)。 */
  readonly started_at: Date;
  /** 结束时间戳 (UTC), 未结束为 null。 */
  readonly finished_at: Date | null;
}

/**
 * 构造 WorkerOutcome, 补默认值 (等价 Python dataclass 默认值 + default_factory)。
 *
 * started_at 缺省取当前 UTC; 其余可选字段缺省为 null / 空串。
 */
export function makeWorkerOutcome(init: {
  status: WorkerStatus;
  test_results?: TestResults | null;
  summary_text?: string;
  key_diffs_file?: KeyDiffsFile | null;
  plan_amendment?: PlanAmendmentNeeded | null;
  failure_reason?: string;
  started_at?: Date;
  finished_at?: Date | null;
}): WorkerOutcome {
  return {
    status: init.status,
    test_results: init.test_results ?? null,
    summary_text: init.summary_text ?? "",
    key_diffs_file: init.key_diffs_file ?? null,
    plan_amendment: init.plan_amendment ?? null,
    failure_reason: init.failure_reason ?? "",
    started_at: init.started_at ?? new Date(),
    finished_at: init.finished_at ?? null,
  };
}

/**
 * worker 派发抽象 (鸭子类型 interface)。
 *
 * 真实实现由宿主提供 (Claude Code subagent / inline mock)。本接口只约束契约:
 * dispatch 是阻塞调用, 派一个 worker 跑完一个 task 再返回。
 * 失败 (timeout / crash / 失联) 不在 dispatch 内处理 —— 那是 watchdog 的事 (§3.3)。
 * 本方法只返正常交回的 outcome。
 */
export interface WorkerRunner {
  /** 派发一个 worker, 阻塞等回收。 */
  dispatch(packet: WorkerPacket, systemPrompt?: string): WorkerOutcome;
}

/**
 * 单上下文兜底模式 (master-prompt §3 A2): 同一进程内 dry-run "扮演" worker。
 *
 * MVP 通过 callback 注入, 不打 LLM。callback 签名:
 *     callback(packet: WorkerPacket) -> WorkerOutcome
 * 用于 dry-run 测试与单上下文宿主。
 */
export class InlineWorkerRunner implements WorkerRunner {
  private readonly callback: (packet: WorkerPacket) => WorkerOutcome;

  constructor(workerCallback: (packet: WorkerPacket) => WorkerOutcome) {
    this.callback = workerCallback;
  }

  dispatch(packet: WorkerPacket, _systemPrompt = ""): WorkerOutcome {
    void _systemPrompt;
    return this.callback(packet);
  }
}

/**
 * 测试用: 把 packet 记录下来, 返回预置 outcome 队列。
 *
 * 典型场景: 端到端 dry-run 测试预置一个 completed outcome, 不依赖真实 worker。
 * outcomes 队列按 dispatch 顺序消费; 队列耗尽时 throw (测试编排错误)。
 */
export class RecordingWorkerRunner implements WorkerRunner {
  private readonly outcomes: WorkerOutcome[];
  /** 记录所有被派发过的 packet (供测试断言)。 */
  readonly dispatchedPackets: WorkerPacket[] = [];

  constructor(outcomes: WorkerOutcome[]) {
    this.outcomes = [...outcomes];
  }

  dispatch(packet: WorkerPacket, _systemPrompt = ""): WorkerOutcome {
    void _systemPrompt;
    this.dispatchedPackets.push(packet);
    const next = this.outcomes.shift();
    if (next === undefined) {
      throw new Error("no more preset outcomes (RecordingWorkerRunner 队列耗尽)");
    }
    return next;
  }
}
