/**
 * dispatch 子包汇总导出 (P5-M7A, 等价 Python `loop_engineering/dispatch/`)。
 *
 * 3 个模块:
 * - packet: buildPacket / WorkerPacket —— coordinator 给 worker 的最小派发 packet (§0.4)。
 * - worker_runner: WorkerRunner 抽象 + InlineWorkerRunner / RecordingWorkerRunner
 *   (dry-run echo 占位 worker, 非真实派发) + WorkerOutcome 三态 (§3.6 / §2.2)。
 * - collect: collectOutcome —— worker 交回后 actual_writes 独立采集 + 越界检测 + checks 求值
 *   + 任务自检串联 (§3.4 / §0.2 / §2.2); 含内存版 actual_writes 采集 API。
 */
export * from "./packet.js";
export * from "./worker_runner.js";
export * from "./collect.js";
