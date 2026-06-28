/**
 * watchdog 等价测试 (P4-M3, design §3.3)。
 *
 * 行为权威: Python `tests/test_watchdog.py` + `loop_engineering/scheduling/watchdog.py`。
 * 被测实现: `packages/ssot-ts/src/scheduling/watchdog.ts`。
 *
 * 覆盖: detectStaleTasks / watchdogTick / applyWatchdogDecision / writeWatchdogEvent /
 * shouldSuggestAbort。时间用可注入的 Date (对齐 Python now/started_at 参数注入做法);
 * writeWatchdogEvent 用临时 run 目录夹具。
 */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  applyWatchdogDecision,
  detectStaleTasks,
  shouldSuggestAbort,
  watchdogTick,
  writeWatchdogEvent,
  type WatchdogDecision,
} from "../../packages/ssot-ts/src/scheduling/watchdog.js";
import { TaskSchema, TaskStatus } from "../../packages/ssot-ts/src/schema/task_plan.js";
import type { Task } from "../../packages/ssot-ts/src/schema/task_plan.js";

/** 构造测试 task (最小字段, 经 zod 补默认值)。 */
function makeTask(
  taskId = "T1",
  status: TaskStatus = TaskStatus.running,
  attempt = 0,
): Task {
  return TaskSchema.parse({
    id: taskId,
    title: `task ${taskId}`,
    allowed_write_paths: ["a/**"],
    acceptance_refs: ["AC1"],
    status,
    attempt,
  });
}

/** 临时 run 目录 (用后即清)。 */
function makeTmpRunDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loop-wd-"));
}

/** now = 2026-06-27T12:00:00Z (与 Python 测试基准一致)。 */
function baseNow(): Date {
  return new Date(Date.UTC(2026, 5, 27, 12, 0, 0));
}

/** 在 now 基础上减去若干分钟。 */
function minutesBefore(now: Date, mins: number): Date {
  return new Date(now.getTime() - mins * 60 * 1000);
}

// ---------------------------------------------------------------------------
// detectStaleTasks
// ---------------------------------------------------------------------------

test("[py: test_detect_stale_tasks_finds_overdue] running + 超时 → 找到", () => {
  const now = baseNow();
  const started = minutesBefore(now, 30);
  const tasks = [makeTask("T1")];
  const stale = detectStaleTasks(tasks, now, 15, { T1: started });
  expect(stale).toEqual(tasks);
});

test("[py: test_detect_stale_tasks_skips_non_running] pending/complete/blocked 不算 stale", () => {
  const now = baseNow();
  const started = minutesBefore(now, 600);
  const tasks = [
    makeTask("T1", TaskStatus.pending),
    makeTask("T2", TaskStatus.complete),
    makeTask("T3", TaskStatus.blocked),
  ];
  const startedMap: Record<string, Date> = {};
  for (const t of tasks) startedMap[t.id] = started;
  const stale = detectStaleTasks(tasks, now, 15, startedMap);
  expect(stale).toEqual([]);
});

test("[py: test_detect_stale_tasks_skips_recent] running + 未超时 → 不算 stale", () => {
  const now = baseNow();
  const started = minutesBefore(now, 5);
  const stale = detectStaleTasks([makeTask("T1")], now, 15, { T1: started });
  expect(stale).toEqual([]);
});

test("[py: test_detect_stale_tasks_skips_running_without_started_at] 缺 started_at → 保守不回收", () => {
  const now = baseNow();
  const stale = detectStaleTasks([makeTask("T1")], now, 15, {});
  expect(stale).toEqual([]);
});

// ---------------------------------------------------------------------------
// watchdogTick
// ---------------------------------------------------------------------------

test("[py: test_watchdog_tick_recycle_on_first_timeout] stale=0, max=1 → recycle, attempt=1", () => {
  const now = baseNow();
  const started = minutesBefore(now, 30);
  const decisions = watchdogTick([makeTask("T1", TaskStatus.running, 0)], { T1: started }, { T1: 0 }, now, 15, 1);
  expect(decisions.length).toBe(1);
  const d = decisions[0];
  expect(d.action).toBe("recycle_to_pending");
  expect(d.new_attempt).toBe(1);
  expect(d.new_status).toBe(TaskStatus.pending);
  expect(d.event).not.toBeNull();
  expect(d.event?.reason).toBe("timeout");
  expect(d.event?.attempt).toBe(0);
});

test("[py: test_watchdog_tick_block_after_max_retries] stale=1=max, 再超时 → mark_blocked, attempt 不变", () => {
  const now = baseNow();
  const started = minutesBefore(now, 30);
  const decisions = watchdogTick([makeTask("T1", TaskStatus.running, 1)], { T1: started }, { T1: 1 }, now, 15, 1);
  expect(decisions.length).toBe(1);
  const d = decisions[0];
  expect(d.action).toBe("mark_blocked");
  expect(d.new_attempt).toBe(1);
  expect(d.new_status).toBe(TaskStatus.blocked);
  expect(d.event).not.toBeNull();
  expect(d.event?.reason).toBe("no_response");
});

test("[py: test_watchdog_tick_no_action_when_not_overdue] 未超时 → no_action", () => {
  const now = baseNow();
  const started = minutesBefore(now, 5);
  const decisions = watchdogTick([makeTask("T1", TaskStatus.running, 0)], { T1: started }, {}, now, 15, 1);
  expect(decisions.length).toBe(1);
  const d = decisions[0];
  expect(d.action).toBe("no_action");
  expect(d.new_attempt).toBe(0);
  expect(d.new_status).toBe(TaskStatus.running);
  expect(d.event).toBeNull();
});

// ---------------------------------------------------------------------------
// applyWatchdogDecision
// ---------------------------------------------------------------------------

test("[py: test_apply_watchdog_decision_recycle] recycle 后 status=pending, attempt+1, 其他不变", () => {
  const task = makeTask("T1", TaskStatus.running, 0);
  const decision: WatchdogDecision = {
    task_id: "T1",
    action: "recycle_to_pending",
    new_attempt: 1,
    new_status: TaskStatus.pending,
    reason: "timeout",
    event: {
      task_id: "T1",
      reason: "timeout",
      attempt: 0,
      timestamp: "2026-06-27T12:00:00+00:00",
      started_at: "2026-06-27T11:30:00+00:00",
    },
  };
  const newTask = applyWatchdogDecision(task, decision);
  expect(newTask.status).toBe(TaskStatus.pending);
  expect(newTask.attempt).toBe(1);
  expect(newTask.id).toBe("T1");
  expect(newTask.title).toBe("task T1");
  expect(newTask.allowed_write_paths).toEqual(["a/**"]);
});

test("[py: test_apply_watchdog_decision_block] block 后 status=blocked, attempt 不变, 其他不变", () => {
  const task = makeTask("T1", TaskStatus.running, 1);
  const decision: WatchdogDecision = {
    task_id: "T1",
    action: "mark_blocked",
    new_attempt: 1,
    new_status: TaskStatus.blocked,
    reason: "max_retries_exhausted",
    event: {
      task_id: "T1",
      reason: "no_response",
      attempt: 1,
      timestamp: "2026-06-27T12:00:00+00:00",
      started_at: "2026-06-27T11:30:00+00:00",
    },
  };
  const newTask = applyWatchdogDecision(task, decision);
  expect(newTask.status).toBe(TaskStatus.blocked);
  expect(newTask.attempt).toBe(1);
  expect(newTask.id).toBe("T1");
});

// ---------------------------------------------------------------------------
// writeWatchdogEvent
// ---------------------------------------------------------------------------

test("[py: test_write_watchdog_event_creates_file_if_missing] 文件不存在 → 建", () => {
  const runDir = makeTmpRunDir();
  try {
    const decision: WatchdogDecision = {
      task_id: "T1",
      action: "recycle_to_pending",
      new_attempt: 1,
      new_status: TaskStatus.pending,
      reason: "timeout",
      event: {
        task_id: "T1",
        reason: "timeout",
        attempt: 0,
        timestamp: "2026-06-27T12:00:00+00:00",
        started_at: "2026-06-27T11:30:00+00:00",
      },
    };
    const logPath = path.join(runDir, "tasks", "T1", "logs", "watchdog.json");
    expect(fs.existsSync(logPath)).toBe(false);
    writeWatchdogEvent(runDir, decision);
    expect(fs.existsSync(logPath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(logPath, "utf-8"));
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(1);
    expect(data[0].task_id).toBe("T1");
    expect(data[0].reason).toBe("timeout");
    expect(data[0].attempt).toBe(0);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("[py: test_write_watchdog_event_appends_to_log] 已存在 → 追加, 不覆盖", () => {
  const runDir = makeTmpRunDir();
  try {
    const logPath = path.join(runDir, "tasks", "T1", "logs", "watchdog.json");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const existing = [
      {
        task_id: "T1",
        reason: "timeout",
        attempt: 0,
        timestamp: "2026-06-27T11:00:00+00:00",
        started_at: "2026-06-27T10:30:00+00:00",
      },
    ];
    fs.writeFileSync(logPath, JSON.stringify(existing), "utf-8");

    const decision: WatchdogDecision = {
      task_id: "T1",
      action: "mark_blocked",
      new_attempt: 1,
      new_status: TaskStatus.blocked,
      reason: "max_retries_exhausted",
      event: {
        task_id: "T1",
        reason: "no_response",
        attempt: 1,
        timestamp: "2026-06-27T12:00:00+00:00",
        started_at: "2026-06-27T11:30:00+00:00",
      },
    };
    writeWatchdogEvent(runDir, decision);
    const data = JSON.parse(fs.readFileSync(logPath, "utf-8"));
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(2);
    expect(data[0].attempt).toBe(0);
    expect(data[1].attempt).toBe(1);
    expect(data[1].reason).toBe("no_response");
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("[py: test_write_watchdog_event_no_action_does_nothing] no_action (event=null) 不写文件", () => {
  const runDir = makeTmpRunDir();
  try {
    const decision: WatchdogDecision = {
      task_id: "T1",
      action: "no_action",
      new_attempt: 0,
      new_status: TaskStatus.running,
      reason: "not_overdue",
      event: null,
    };
    const logPath = path.join(runDir, "tasks", "T1", "logs", "watchdog.json");
    writeWatchdogEvent(runDir, decision);
    expect(fs.existsSync(logPath)).toBe(false);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// shouldSuggestAbort
// ---------------------------------------------------------------------------

test("[py: test_should_suggest_abort_above_threshold] >50% task 有 stale → True", () => {
  const tasks = [makeTask("T1"), makeTask("T2"), makeTask("T3")];
  const staleCounts = { T1: 1, T2: 1, T3: 0 }; // 2/3 ≈ 0.67 > 0.5
  expect(shouldSuggestAbort(tasks, staleCounts, 0.5)).toBe(true);
});

test("[py: test_should_suggest_abort_counts_tasks_not_instances] 同 task 多次 stale 只算 1", () => {
  const tasks = [makeTask("T1"), makeTask("T2")];
  const staleCounts = { T1: 5, T2: 0 }; // 分子只算 1 个 task
  expect(shouldSuggestAbort(tasks, staleCounts, 0.5)).toBe(false);
});

test("[py: test_should_suggest_abort_below_threshold] 10% → False", () => {
  const ids = ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10"];
  const tasks = ids.map((t) => makeTask(t));
  const staleCounts = { T1: 1 }; // 1/10 = 10%
  expect(shouldSuggestAbort(tasks, staleCounts, 0.5)).toBe(false);
});

test("[py: test_should_suggest_abort_empty_tasks] 总数 0 → False (避免除零)", () => {
  expect(shouldSuggestAbort([], {}, 0.5)).toBe(false);
});

test("[py: test_should_suggest_abort_exactly_at_threshold_is_false] 1/2=0.5 不 > 0.5 → False", () => {
  const tasks = [makeTask("T1"), makeTask("T2")];
  const staleCounts = { T1: 1, T2: 0 };
  expect(shouldSuggestAbort(tasks, staleCounts, 0.5)).toBe(false);
});
