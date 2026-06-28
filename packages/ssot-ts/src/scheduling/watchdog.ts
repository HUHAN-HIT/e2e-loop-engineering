/**
 * task `running` 的 watchdog 回收 (design §3.3)。
 *
 * 行为权威: Python `loop_engineering/scheduling/watchdog.py`。
 * 规范源: design §3.3 —— worker 派出后失联回收。要点:
 * - 心跳 / 超时: started_at + watchdog_timeout_min < now → 写 timeout 事件触发回收。
 * - 回收动作: task 退回 pending, active_tasks 移除, attempt +1, 写 watchdog.json 一条事件。
 * - 重试策略: 同 task 默认重派 max_retries_per_task 次; 仍 stale → 标 blocked。
 * - 整体推进: 发生过 stale 的 task 数 / 总 task 数 > 50% → 建议人转 ABORTED (按 task 计不按次计)。
 * - watchdog 只处理 worker 失联, 不替代 §2 自检; 两者计数独立。
 *
 * 本模块**不持有** started_at / stale_count 等运行时状态 —— 这些由 coordinator 外部维护,
 * 作为参数传入, 使本模块成为纯函数, 便于单测 (§3.5 AR3 收敛点)。
 *
 * 与 Python 的差异: started_at_by_task / now 用 JS `Date`; 字典用 `Map` 或普通 record 均可
 * (取值统一走 `mapGet` 兼容两者)。
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { Task } from "../schema/task_plan.js";
import { TaskStatus } from "../schema/task_plan.js";

/** 从 Map 或普通 record 取值, 缺失返回 undefined (兼容两种入参形态)。 */
function mapGet<V>(
  m: Map<string, V> | Record<string, V>,
  key: string,
): V | undefined {
  return m instanceof Map ? m.get(key) : m[key];
}

/** 入参字典类型: 接受 Map 或普通对象。 */
export type DateByTask = Map<string, Date> | Record<string, Date>;
export type CountByTask = Map<string, number> | Record<string, number>;

/**
 * watchdog.json 里的一条事件记录。
 * 一条事件对应一次回收动作 (timeout / crash / no_response)。
 */
export interface WatchdogEvent {
  task_id: string;
  reason: string; // "timeout" | "crash" | "no_response"
  attempt: number; // 此次作废的 attempt 序号
  timestamp: string; // ISO 8601 UTC
  started_at: string; // worker 派出时间 (用于诊断)
}

/**
 * 单次 watchdog_tick 对一个 task 的处置决策。
 *
 * action 三态:
 * - recycle_to_pending: 超时且仍有重派额度, 退回 pending, attempt +1。
 * - mark_blocked: 重派已耗尽仍 stale, 标 blocked, attempt 不变。
 * - no_action: 未超时, 不动。
 */
export interface WatchdogDecision {
  task_id: string;
  action: "recycle_to_pending" | "mark_blocked" | "no_action";
  new_attempt: number;
  new_status: TaskStatus;
  reason: string;
  event: WatchdogEvent | null; // no_action 时为 null
}

/**
 * Date → ISO 8601 UTC 字符串 (用作 timestamp / started_at)。
 *
 * 复刻 Python `_iso_utc` 的输出格式: `YYYY-MM-DDTHH:MM:SS+00:00` (无毫秒, 带 +00:00 偏移),
 * 而非 JS 原生 `toISOString()` 的 `...Z` + 毫秒形态, 以便与 Python 端事件文件对齐。
 */
function isoUtc(dt: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const y = dt.getUTCFullYear();
  const mo = pad(dt.getUTCMonth() + 1);
  const d = pad(dt.getUTCDate());
  const h = pad(dt.getUTCHours());
  const mi = pad(dt.getUTCMinutes());
  const s = pad(dt.getUTCSeconds());
  return `${y}-${mo}-${d}T${h}:${mi}:${s}+00:00`;
}

/**
 * 找出 running 且 started_at + timeout < now 的 task (design §3.3)。
 *
 * started_at 由 coordinator 通过 startedAtByTask 外部传入 (本模块不持有)。
 * 缺 started_at 的 running task 视为无法判定, 不算 stale (保守不回收)。
 */
export function detectStaleTasks(
  tasks: readonly Task[],
  now: Date,
  timeoutMinutes: number,
  startedAtByTask: DateByTask,
): Task[] {
  const timeoutSeconds = timeoutMinutes * 60;
  const stale: Task[] = [];
  for (const t of tasks) {
    if (t.status !== TaskStatus.running) continue;
    const started = mapGet(startedAtByTask, t.id);
    if (started === undefined) continue;
    const elapsed = (now.getTime() - started.getTime()) / 1000;
    if (elapsed > timeoutSeconds) stale.push(t);
  }
  return stale;
}

/**
 * 单次 tick: 对每个 running task 检查超时, 决定 recycle / mark_blocked / no_action。
 *
 * 决策矩阵 (§3.3):
 * - 未超时 → no_action。
 * - 超时且 stale_count < max_retries → recycle_to_pending (重派, attempt +1)。
 * - 超时且 stale_count >= max_retries → mark_blocked (重派额度耗尽, 升级给人)。
 *
 * staleCountByTask: coordinator 维护的"该 task 累计 stale 次数", tick 不修改它
 * (apply 后由 coordinator 外部 +1, 与本模块解耦)。
 */
export function watchdogTick(
  tasks: readonly Task[],
  startedAtByTask: DateByTask,
  staleCountByTask: CountByTask,
  now: Date,
  timeoutMinutes: number,
  maxRetries: number,
): WatchdogDecision[] {
  const timeoutSeconds = timeoutMinutes * 60;
  const decisions: WatchdogDecision[] = [];

  for (const t of tasks) {
    if (t.status !== TaskStatus.running) continue;
    const started = mapGet(startedAtByTask, t.id);
    if (started === undefined) continue;

    const elapsed = (now.getTime() - started.getTime()) / 1000;
    if (elapsed <= timeoutSeconds) {
      decisions.push({
        task_id: t.id,
        action: "no_action",
        new_attempt: t.attempt,
        new_status: TaskStatus.running,
        reason: "not_overdue",
        event: null,
      });
      continue;
    }

    const staleCount = mapGet(staleCountByTask, t.id) ?? 0;
    const timestamp = isoUtc(now);
    const startedStr = isoUtc(started);

    if (staleCount < maxRetries) {
      // 仍有重派额度 → 退回 pending 重派, attempt +1。
      decisions.push({
        task_id: t.id,
        action: "recycle_to_pending",
        new_attempt: t.attempt + 1,
        new_status: TaskStatus.pending,
        reason: "timeout",
        event: {
          task_id: t.id,
          reason: "timeout",
          attempt: t.attempt,
          timestamp,
          started_at: startedStr,
        },
      });
    } else {
      // 重派额度耗尽 → 标 blocked, attempt 不变 (§3.3 "计数独立, 不共享额度")。
      decisions.push({
        task_id: t.id,
        action: "mark_blocked",
        new_attempt: t.attempt,
        new_status: TaskStatus.blocked,
        reason: "max_retries_exhausted",
        event: {
          task_id: t.id,
          reason: "no_response",
          attempt: t.attempt,
          timestamp,
          started_at: startedStr,
        },
      });
    }
  }

  return decisions;
}

/**
 * 按 decision 修改 task (仅 status / attempt, 不动其他字段)。
 *
 * 复刻 Python `model_copy(update={...})`: 浅拷贝 task 后覆盖 status / attempt;
 * no_action 决策也允许传入 (返回等价副本)。
 */
export function applyWatchdogDecision(
  task: Task,
  decision: WatchdogDecision,
): Task {
  return { ...task, status: decision.new_status, attempt: decision.new_attempt };
}

/**
 * 把 decision.event 追加到 tasks/<id>/logs/watchdog.json。
 *
 * 文件不存在则建; 已存在则读出数组追加。数组形式便于人查回收历史。
 * no_action 决策的 event 为 null → 不写。
 * 损坏文件不阻塞回收, 从空重新写 (人后续可查 git 历史)。
 */
export function writeWatchdogEvent(
  runDir: string,
  decision: WatchdogDecision,
): void {
  if (decision.event === null) return;
  const logPath = path.join(
    runDir,
    "tasks",
    decision.task_id,
    "logs",
    "watchdog.json",
  );
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  let events: unknown[] = [];
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(logPath, "utf-8"));
    if (Array.isArray(raw)) events = raw;
  } catch {
    // 文件不存在 / 损坏 → 从空数组重新写。
    events = [];
  }

  events.push({
    task_id: decision.event.task_id,
    reason: decision.event.reason,
    attempt: decision.event.attempt,
    timestamp: decision.event.timestamp,
    started_at: decision.event.started_at,
  });

  fs.writeFileSync(logPath, `${JSON.stringify(events, null, 2)}\n`, "utf-8");
}

/**
 * §3.3: 发生过 ≥1 次 stale 的 task 数 / 总 task 数 > threshold → True。
 *
 * 分子分母都按 task 计不按次计 (同一 task 多次 stale 只算 1)。
 * 总 task 数为 0 时返回 False (避免除零)。
 */
export function shouldSuggestAbort(
  tasks: readonly Task[],
  staleCountByTask: CountByTask,
  threshold = 0.5,
): boolean {
  const total = tasks.length;
  if (total === 0) return false;

  let staleTaskCount = 0;
  if (staleCountByTask instanceof Map) {
    for (const v of staleCountByTask.values()) {
      if (v >= 1) staleTaskCount += 1;
    }
  } else {
    for (const v of Object.values(staleCountByTask)) {
      if (v >= 1) staleTaskCount += 1;
    }
  }
  return staleTaskCount / total > threshold;
}
