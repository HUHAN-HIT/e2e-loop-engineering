/**
 * 单 tick 顺序 (design §3.7): ABORTED > 收回 outcomes > watchdog > readyFrontier。
 *
 * 行为权威: Python `loop_engineering/runtime/tick.py`。
 * 规范源: design §3.7 —— 单次 tick 的执行顺序严格固定:
 * 1. ABORTED check: 若 state.phase==ABORTED → 立即返回 (不再调度, 优先级最高)。
 * 2. 收回已交回的 worker outcomes: 跑 collectOutcome + 任务自检; pass→complete, fail→保留
 *    running 等待 fix-once (§2.2); plan_amendment → 交回 caller (coordinator) 处理回滚。
 * 3. watchdogTick: 检查 running task 是否超时, recycle / mark_blocked。
 * 4. readyFrontier: 选 ready task, 立即翻 running, 派发 WorkerPacket。
 * 5. 透传 human_pending 状态 (tick 自身不设 anchor, 那是 coordinator 的 submit_* 方法的事)。
 *
 * 本函数是纯函数风格: 输入 state + plan + runner, 返回新 (state, plan, TickResult)。
 * 不可变 (复制新对象), 不修改 state/plan 入参 (但 startedAtByTask / staleCountByTask /
 * beforeSnapshots / earlierTaskWrites / baseRefs 这几个外部 map 会被原地更新 —— 与 Python
 * 一致: 它们是 coordinator 持有的可变运行时状态, tick 负责维护)。
 */
import { collectOutcome } from "../dispatch/collect.js";
import type { CollectedTaskResult, FsSnapshot } from "../dispatch/collect.js";
import { buildPacket } from "../dispatch/packet.js";
import type { WorkerOutcome, WorkerRunner } from "../dispatch/worker_runner.js";
import { takeFsSnapshot, takeGitBaseRef } from "../dispatch/collect.js";
import { readyFrontier } from "../scheduling/ready_frontier.js";
import {
  applyWatchdogDecision,
  shouldSuggestAbort,
  watchdogTick,
  writeWatchdogEvent,
} from "../scheduling/watchdog.js";
import type { WatchdogDecision } from "../scheduling/watchdog.js";
import { Phase } from "../schema/run_state.js";
import type { RunCapabilities, RunState } from "../schema/run_state.js";
import { TaskStatus } from "../schema/task_plan.js";
import type { Task, TaskPlan } from "../schema/task_plan.js";

/** 单次 tick 的执行记录 (用于日志 + 测试)。 */
export interface TickResult {
  /** 是否触发 ABORTED 短路 (优先级最高)。 */
  readonly aborted_check: boolean;
  /** 本 tick 的 watchdog 决策 (no_action 也算)。 */
  readonly watchdog_actions: WatchdogDecision[];
  /** 本批 readyFrontier 选中的 task_id。 */
  readonly ready_selected: string[];
  /** 实际派发的 task_id (ready_selected 中能派发的)。 */
  readonly dispatched: string[];
  /** tick 后是否需要等人 (anchor 被设置)。 */
  readonly human_pending_now: boolean;
  /** watchdog 建议 ABORTED (stale 占比 > 50%, design §3.3)。 */
  readonly suggested_abort: boolean;
  /**
   * 本 tick 收到的 plan_amendment 信号列表 (CollectedTaskResult 形式),
   * coordinator 拿到后跑 computeRollback + apply。tick 自身不处理回滚。
   */
  readonly plan_amendments: CollectedTaskResult[];
  /**
   * 本 tick 内自检通过转为 complete 的 task 的 CollectedTaskResult 列表。
   * coordinator 拿来填充 key_diffs / task_check 缓存给收口自检用。
   */
  readonly completed_results: CollectedTaskResult[];
}

/** 单 tick 的外部可变运行时状态 (coordinator 持有, tick 原地维护)。 */
export interface TickRuntime {
  /** task_id → 派出时间 (watchdog 用)。 */
  startedAtByTask: Map<string, Date>;
  /** task_id → 累计 stale 次数 (watchdog 用)。 */
  staleCountByTask: Map<string, number>;
  /** task_id → 派出前的 fs snapshot (actual_writes 采集用)。 */
  beforeSnapshots: Map<string, FsSnapshot>;
  /** task_id → 该 task 的实际写入列表 (越界检测第 2 层用)。 */
  earlierTaskWrites: Map<string, string[]>;
  /** task_id → 派出前的 git base ref (capabilities.git_diff=true 时填)。 */
  baseRefs: Map<string, string>;
}

/** tick 的可选输入 (路径 / 能力 / 外部预填 outcome 等)。 */
export interface TickOptions {
  now: Date;
  /** 上一轮 dispatch 的回填 outcome (task_id → outcome)。 */
  workerOutcomes?: Map<string, WorkerOutcome> | null;
  /** 宿主能力 (null 时 collect 用 self_report 兜底)。 */
  capabilities?: RunCapabilities | null;
  /** buildPacket 用: planning/design.md 路径。 */
  designMd?: string | null;
  /** buildPacket 用: planning/task-plan.yaml 路径。 */
  taskPlanYaml?: string | null;
  /** buildPacket / watchdog 写事件用: run 根目录。 */
  runDir?: string | null;
  /** buildPacket / actual_writes 用: 真实代码工作目录。 */
  workdir?: string | null;
}

/** 按当前 run 的复杂度档位取 watchdog 超时分钟数。 */
function phaseTimeoutMinutes(state: RunState, complexity: string): number {
  const cfg = state.config;
  if (complexity === "simple") return cfg.watchdog_timeout_min.simple;
  if (complexity === "medium") return cfg.watchdog_timeout_min.medium;
  return cfg.watchdog_timeout_min.complex;
}

/**
 * 单 tick。严格按 §3.7 顺序执行。
 *
 * @param state 当前 RunState (不被修改)。
 * @param plan 当前 TaskPlan (不被修改)。
 * @param runner WorkerRunner (派发用)。
 * @param runtime 外部可变运行时 map (startedAt / staleCount / snapshots / 等), 原地维护。
 * @param options now / workerOutcomes / capabilities / 路径 等。
 * @returns [newState, newPlan, TickResult]。不可变风格 (新对象)。
 */
export function tick(
  state: RunState,
  plan: TaskPlan,
  runner: WorkerRunner,
  runtime: TickRuntime,
  options: TickOptions,
): [RunState, TaskPlan, TickResult] {
  // 步骤 1: ABORTED check (优先级最高)
  if (state.phase === Phase.ABORTED) {
    return [
      state,
      plan,
      {
        aborted_check: true,
        watchdog_actions: [],
        ready_selected: [],
        dispatched: [],
        human_pending_now: false,
        suggested_abort: false,
        plan_amendments: [],
        completed_results: [],
      },
    ];
  }

  const workerOutcomes = options.workerOutcomes ?? new Map<string, WorkerOutcome>();
  const capabilities: RunCapabilities =
    options.capabilities ?? { git_diff: false, fs_snapshot: false };
  const now = options.now;
  const runDir = options.runDir ?? null;
  const workdir = options.workdir ?? undefined;
  const designMd = options.designMd ?? "planning/design.md";
  const taskPlanYaml = options.taskPlanYaml ?? "planning/task-plan.yaml";

  const newActive: string[] = [...state.active_tasks];
  const collectedAmendments: CollectedTaskResult[] = [];
  const collectedCompleted: CollectedTaskResult[] = [];
  const dispatchedIds: string[] = [];
  // 初始引用; 后续步骤会复制新对象更新 (不可变)。
  let newPlan: TaskPlan = plan;

  // earlierTaskWrites 以普通 record 形式喂给 detectOutOfBounds (与 Python dict 一致)。
  const earlierTaskWritesRecord = (): Record<string, string[]> => {
    const rec: Record<string, string[]> = {};
    for (const [k, v] of runtime.earlierTaskWrites) rec[k] = v;
    return rec;
  };

  /** 处理一个 outcome: 自检通过 → complete; plan_amendment → 收集; 其它 → 留 running。 */
  const consumeOutcome = (taskId: string, outcome: WorkerOutcome): void => {
    // 从当前 newPlan.tasks 找最新 task 状态 (watchdog 步骤会重建 newPlan)。
    const currentTasks = [...newPlan.tasks];
    const idx = currentTasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return;
    const taskObj = currentTasks[idx]!;
    if (taskObj.status !== TaskStatus.running) {
      // 任务已不在 running (例如已被 watchdog 回收), 丢弃迟到 outcome。
      return;
    }

    const packet = buildPacket(taskObj, newPlan, runDir ?? ".", {
      designMd,
      taskPlanYaml,
      workdir,
    });

    const collected = collectOutcome(taskObj, outcome, packet, capabilities, {
      baseRef: runtime.baseRefs.get(taskId) ?? null,
      beforeSnapshot: runtime.beforeSnapshots.get(taskId) ?? null,
      earlierTaskWrites: earlierTaskWritesRecord(),
    });

    if (outcome.status === "plan_amendment") {
      collectedAmendments.push(collected);
      return;
    }

    if (outcome.status === "completed" && collected.task_check_result.all_pass) {
      currentTasks[idx] = { ...taskObj, status: TaskStatus.complete };
      newPlan = { ...newPlan, tasks: currentTasks };
      const ai = newActive.indexOf(taskId);
      if (ai !== -1) newActive.splice(ai, 1);
      runtime.startedAtByTask.delete(taskId);
      // 回写 earlierTaskWrites (后续 task 越界检测第 2 层用)。
      runtime.earlierTaskWrites.set(taskId, [...collected.actual_writes.writes]);
      // 收集 complete 结果给 coordinator。
      collectedCompleted.push(collected);
    }
    // 其它情况: 保留 running, 等 watchdog 或下一次 fix-once。
  };

  // 步骤 2: 收回已交回的 worker outcomes (上一轮外部预填的 outcome)。
  for (const [tid, outcome] of [...workerOutcomes.entries()]) {
    consumeOutcome(tid, outcome);
    workerOutcomes.delete(tid);
  }

  // 步骤 3: watchdogTick (检查 running task 是否超时)
  const timeoutMin = phaseTimeoutMinutes(state, newPlan.complexity);
  const decisions = watchdogTick(
    newPlan.tasks,
    runtime.startedAtByTask,
    runtime.staleCountByTask,
    now,
    timeoutMin,
    state.config.max_retries_per_task,
  );

  // 应用 watchdog 决策 (修改 task.status / attempt, 写 watchdog 事件)。
  const watchdogTasks: Task[] = [...newPlan.tasks];
  for (const dec of decisions) {
    if (dec.action === "no_action") continue;
    const idx = watchdogTasks.findIndex((t) => t.id === dec.task_id);
    if (idx === -1) continue;
    watchdogTasks[idx] = applyWatchdogDecision(watchdogTasks[idx]!, dec);
    // active_tasks 跟随状态变化。
    if (dec.action === "recycle_to_pending" || dec.action === "mark_blocked") {
      const ai = newActive.indexOf(dec.task_id);
      if (ai !== -1) newActive.splice(ai, 1);
      runtime.startedAtByTask.delete(dec.task_id);
      if (dec.action === "recycle_to_pending") {
        runtime.staleCountByTask.set(
          dec.task_id,
          (runtime.staleCountByTask.get(dec.task_id) ?? 0) + 1,
        );
      }
    }
    if (runDir !== null) {
      writeWatchdogEvent(runDir, dec);
    }
  }

  newPlan = { ...newPlan, tasks: watchdogTasks };

  const suggestedAbort = shouldSuggestAbort(newPlan.tasks, runtime.staleCountByTask);

  // 步骤 4: readyFrontier + 派发 (仅 IMPLEMENTING phase)。
  const readyIds: string[] = [];
  if (state.phase === Phase.IMPLEMENTING) {
    const activeTaskObjs = newPlan.tasks.filter((t) => newActive.includes(t.id));
    const ready = readyFrontier(newPlan.tasks, activeTaskObjs);
    for (const r of ready) readyIds.push(r.id);

    for (const r of ready) {
      // 立即翻 running (修改 newPlan.tasks)。
      const curTasks = [...newPlan.tasks];
      const idx = curTasks.findIndex((x) => x.id === r.id);
      const runningTask: Task = { ...curTasks[idx]!, status: TaskStatus.running };
      curTasks[idx] = runningTask;
      newPlan = { ...newPlan, tasks: curTasks };
      newActive.push(r.id);

      // 派发
      const packet = buildPacket(runningTask, newPlan, runDir ?? ".", {
        designMd,
        taskPlanYaml,
        workdir,
      });
      // 取派发前 snapshot (capabilities.fs_snapshot=true 时)。
      if (capabilities.fs_snapshot) {
        runtime.beforeSnapshots.set(r.id, takeFsSnapshot(packet.workdir));
      }
      // 取派发前 git base_ref (capabilities.git_diff=true 时, §3.4 base ref 采集)。
      if (capabilities.git_diff) {
        const ref = takeGitBaseRef(packet.workdir);
        if (ref !== null) runtime.baseRefs.set(r.id, ref);
      }

      const outcome = runner.dispatch(packet);
      runtime.startedAtByTask.set(r.id, now);
      dispatchedIds.push(r.id);
      // 阻塞派发: outcome 在当 tick 内立即消费 (不存到 workerOutcomes)。
      consumeOutcome(r.id, outcome);
    }
  }

  // newState 在所有 active 变更后一次性构造 (active_tasks 反映最终值)。
  const newState: RunState = { ...state, active_tasks: [...newActive] };

  // 步骤 5: 透传人锚点状态 (tick 自身不主动设 human_pending —— 那是 coordinator submit_* 的事)。
  const humanPendingNow =
    newState.human_pending !== null && newState.human_pending !== undefined;

  return [
    newState,
    newPlan,
    {
      aborted_check: false,
      watchdog_actions: decisions,
      ready_selected: readyIds,
      dispatched: dispatchedIds,
      human_pending_now: humanPendingNow,
      suggested_abort: suggestedAbort,
      plan_amendments: collectedAmendments,
      completed_results: collectedCompleted,
    },
  ];
}
