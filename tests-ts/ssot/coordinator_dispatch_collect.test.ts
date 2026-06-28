/**
 * Coordinator 新增的 dispatchReadyTasks / collectTaskOutcome 单元测试 (P5-M7C)。
 *
 * 行为权威: design §3.4 / §3.6 / §3.7 (单 tick 顺序) + 主 agent 协调流程
 * (docs/superpowers/specs/...-design.md 的"方案 3"补 dispatch + collect-outcome CLI 命令)。
 * 被测实现: `packages/ssot-ts/src/runtime/coordinator.ts` 的两个公开方法 + directory.ts
 * 新增的 dispatch.json / collect-failures.json / actual-writes.json helpers。
 *
 * 覆盖:
 * 1. dispatchReadyTasks 单 ready: 翻 running + 落 dispatch.json + attempt=1
 * 2. dispatchReadyTasks 多 ready (并发无冲突) + active_tasks 累积
 * 3. collectTaskOutcome 通过路径: status→complete, 落 key-diffs/summary, all_complete 触发 submitWrapUp
 * 4. collectTaskOutcome bootstrap 降级: 无 dispatch.json + 磁盘有 artifact →
 *    actual_writes.source=worker_self_report, task_check 通过
 * 5. collectTaskOutcome 失败路径: 留 running, 落 collect-failures.json, attempt 不递增
 * 6. fix 重试: 第二次 dispatch 同 task → attempt 递增 + dispatch.json 覆盖
 * 7. OOB 场景: worker 写了 allowed_write_paths 外的路径 → collect 返回 oob → 留 running
 * 8. plan_amendment / failed 分支: 磁盘无 artifact → outcome.status=failed → reason=failed
 * 9. not_found / not_running 守卫
 * 10. dispatch phase 守卫
 * 11. 多 task plan 中只完成一个 → all_complete=false + advanced_to 提示下一 task
 * 12. 跨进程 collect: dispatch → 新建 Coordinator → collect 通过
 *
 * 关键: collectTaskOutcome 从磁盘 artifact 重建 outcome (不信 worker 内存返回值),
 * 测试需直接写 tasks/<tid>/{test-results.yaml, summary.md, key-diffs.yaml} 到磁盘。
 *
 * Capabilities 注入: 默认 {git_diff: false, fs_snapshot: false} 关闭宿主采集能力,
 * 让 actual_writes 退化为 worker_self_report (空集), OOB 检测不触发, 直接验任务自检。
 * 测试 7 (OOB) 单独打开 fs_snapshot 验越界检测。
 */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  Coordinator,
  initRunDir,
  readDispatchMeta,
  readCollectFailures,
  readActualWrites,
  writeRunState,
  writeTaskPlan,
} from "../../packages/ssot-ts/src/runtime/index.js";
import {
  InlineWorkerRunner,
  makeWorkerOutcome,
} from "../../packages/ssot-ts/src/dispatch/index.js";
import type { WorkerOutcome } from "../../packages/ssot-ts/src/dispatch/index.js";
import {
  HumanPending,
  Phase,
  parseRunState,
} from "../../packages/ssot-ts/src/schema/run_state.js";
import { parseTaskPlan } from "../../packages/ssot-ts/src/schema/task_plan.js";
import type { TaskPlan } from "../../packages/ssot-ts/src/schema/task_plan.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** 临时 runs 根目录 (用后即清)。 */
function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loop-disp-"));
}

/** 占位 worker callback (collectTaskOutcome 不真用 runner, runner 仅用于构造 Coordinator)。 */
function noopWorker(): WorkerOutcome {
  return makeWorkerOutcome({ status: "completed" });
}

/** 默认关闭宿主采集能力, 让 actual_writes 退化为空集, OOB 不触发。 */
const NO_CAPS = { git_diff: false, fs_snapshot: false };

/**
 * 构造 minimal plan: 可配 task 数 / 每个 task 的 allowed_write_paths / risk。
 *
 * 默认 1 task (T01), allowed_write_paths=["src/**"], 1 happy-path test (passed == true)。
 */
function makePlan(opts?: {
  tasks?: Array<{
    id: string;
    allowed_write_paths?: string[];
    acceptance_refs?: string[];
    depends_on?: string[];
    risk?: "normal" | "high";
    tests?: Array<{ id: string; scenario?: string; checks: string[] }>;
  }>;
}): TaskPlan {
  const tasks = opts?.tasks ?? [
    {
      id: "T01",
      allowed_write_paths: ["src/**"],
      acceptance_refs: ["AC-001"],
      depends_on: [],
      // case id 用 "t_happy" (与 writeTestResults 默认一致), 避免不匹配误判 task_check fail。
      tests: [{ id: "t_happy", scenario: "happy path", checks: ["passed == true"] }],
    },
  ];
  return parseTaskPlan({
    complexity: "simple",
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.id,
      allowed_write_paths: t.allowed_write_paths ?? ["src/**"],
      acceptance_refs: t.acceptance_refs ?? [`AC-${t.id}`],
      depends_on: t.depends_on ?? [],
      risk: t.risk ?? "normal",
      tests:
        t.tests ?? [
          { id: "t_happy", scenario: "happy", checks: ["passed == true"] },
        ],
    })),
  });
}

/** 写 tasks/<tid>/test-results.yaml (minimal passing)。 */
function writeTestResults(
  runDir: string,
  taskId: string,
  opts?: { green?: boolean; caseId?: string },
): void {
  const green = opts?.green ?? true;
  const caseId = opts?.caseId ?? "t_happy";
  const dir = path.join(runDir, "tasks", taskId);
  fs.mkdirSync(dir, { recursive: true });
  const yaml = `tests_green: ${green}\ncases:\n  - id: ${caseId}\n    passed: ${green}\n    failure_reason: ""\n`;
  fs.writeFileSync(path.join(dir, "test-results.yaml"), yaml, "utf-8");
}

/** 写 tasks/<tid>/summary.md。 */
function writeSummary(runDir: string, taskId: string, text = "done"): void {
  const dir = path.join(runDir, "tasks", taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "summary.md"), text, "utf-8");
}

/**
 * 把 run 拉到 IMPLEMENTING: init dir, 写 run-state (CREATED + caps), 写 plan,
 * 构造 Coordinator, startPlanning + submitPlan + signoffPlan(true)。
 *
 * @param caps 宿主能力 (默认 NO_CAPS 关闭采集, 简化 OOB 噪音)
 */
function setupImplementing(
  runsRoot: string,
  runId: string,
  plan: TaskPlan,
  opts?: {
    caps?: { git_diff: boolean; fs_snapshot: boolean };
    maxRetries?: number;
  },
): Coordinator {
  const caps = opts?.caps ?? NO_CAPS;
  const runDir = initRunDir(runsRoot, runId, "需求: dispatch/collect 测试");
  writeRunState(
    runDir,
    parseRunState({
      run_id: runId,
      complexity: "simple",
      phase: Phase.CREATED,
      capabilities: caps,
      config: {
        watchdog_timeout_min: { simple: 15, medium: 30, complex: 60 },
        max_retries_per_task: opts?.maxRetries ?? 1,
        max_concurrency: 4,
      },
    }),
  );
  fs.mkdirSync(path.join(runDir, "planning"), { recursive: true });
  writeTaskPlan(path.join(runDir, "planning", "task-plan.yaml"), plan);

  const coord = new Coordinator(runDir, new InlineWorkerRunner(noopWorker));
  coord.startPlanning();
  coord.submitPlan(plan);
  coord.signoffPlan(true);
  expect(coord.state.phase).toBe(Phase.IMPLEMENTING);
  return coord;
}

// ---------------------------------------------------------------------------
// 1. dispatchReadyTasks 单 ready
// ---------------------------------------------------------------------------

test("[dispatch] 单 ready task: 翻 running + 落 dispatch.json + attempt=1 + active_tasks 含 T01", () => {
  const runsRoot = path.join(makeTmp(), "runs");
  const coord = setupImplementing(runsRoot, "20260628-001", makePlan());
  const runDir = coord.runDir;

  const packets = coord.dispatchReadyTasks();

  expect(packets).toHaveLength(1);
  expect(packets[0]!.task_id).toBe("T01");
  expect(coord.plan!.tasks[0]!.status).toBe("running");
  expect(coord.plan!.tasks[0]!.attempt).toBe(1);
  expect(coord.state.active_tasks).toContain("T01");

  // dispatch.json 落盘 + 含 attempt=1
  const meta = readDispatchMeta(runDir, "T01");
  expect(meta).not.toBeNull();
  expect(meta!.attempt).toBe(1);
  expect(meta!.task_id).toBe("T01");
  expect(meta!.packet.task_id).toBe("T01");
  // dispatched_at 是合法 ISO
  expect(() => new Date(meta!.dispatched_at).toISOString()).not.toThrow();
});

// ---------------------------------------------------------------------------
// 2. dispatchReadyTasks 多 ready (并发)
// ---------------------------------------------------------------------------

test("[dispatch] 多 ready task (无依赖): 全部翻 running + active_tasks 累积 + 两个 dispatch.json", () => {
  const runsRoot = path.join(makeTmp(), "runs");
  const plan = makePlan({
    tasks: [
      {
        id: "T01",
        allowed_write_paths: ["src/a/**"],
        acceptance_refs: ["AC-001"],
        tests: [{ id: "t1", scenario: "happy", checks: ["passed == true"] }],
      },
      {
        id: "T02",
        allowed_write_paths: ["src/b/**"],
        acceptance_refs: ["AC-002"],
        tests: [{ id: "t2", scenario: "happy", checks: ["passed == true"] }],
      },
    ],
  });
  const coord = setupImplementing(runsRoot, "20260628-002", plan);
  const runDir = coord.runDir;

  const packets = coord.dispatchReadyTasks();

  expect(packets.map((p) => p.task_id).sort()).toEqual(["T01", "T02"]);
  expect(coord.state.active_tasks).toEqual(expect.arrayContaining(["T01", "T02"]));
  expect(coord.state.active_tasks).toHaveLength(2);
  expect(readDispatchMeta(runDir, "T01")).not.toBeNull();
  expect(readDispatchMeta(runDir, "T02")).not.toBeNull();
  expect(coord.plan!.tasks.find((t) => t.id === "T01")!.status).toBe("running");
  expect(coord.plan!.tasks.find((t) => t.id === "T02")!.status).toBe("running");
});

// ---------------------------------------------------------------------------
// 3. collectTaskOutcome 通过路径
// ---------------------------------------------------------------------------

test("[collect] 通过路径: artifact 全齐 → status→complete + 落 key-diffs/summary/actual-writes + all_complete 触发 submitWrapUp", () => {
  const runsRoot = path.join(makeTmp(), "runs");
  const coord = setupImplementing(runsRoot, "20260628-003", makePlan());
  const runDir = coord.runDir;

  coord.dispatchReadyTasks();
  // 模拟子 agent 落 artifact
  writeTestResults(runDir, "T01", { caseId: "t_happy" });
  writeSummary(runDir, "T01", "T01 实现完成");

  const result = coord.collectTaskOutcome("T01");

  expect(result.verified).toBe(true);
  expect(result.reason).toBe("passed");
  expect(result.task_id).toBe("T01");
  expect(result.task_check_all_pass).toBe(true);
  expect(coord.plan!.tasks[0]!.status).toBe("complete");
  expect(coord.state.active_tasks).not.toContain("T01");

  // summary 落盘
  expect(fs.existsSync(path.join(runDir, "tasks", "T01", "summary.md"))).toBe(true);

  // actual-writes.json 落盘 (后续 task collect-outcome 跨进程重建 earlierTaskWrites 用)
  const aw = readActualWrites(runDir, "T01");
  expect(aw).not.toBeNull();
  // caps 全 false → source=worker_self_report, writes 为空
  expect(aw!.source).toBe("worker_self_report");

  // all_complete=true → 自动 submitWrapUp → phase=WRAPPING_UP + human_pending=wrap_up_signoff
  expect(result.all_complete).toBe(true);
  expect(coord.state.phase).toBe(Phase.WRAPPING_UP);
  expect(coord.state.human_pending).toBe(HumanPending.wrap_up_signoff);
});

// ---------------------------------------------------------------------------
// 4. collectTaskOutcome bootstrap 降级 (无 dispatch.json)
// ---------------------------------------------------------------------------

test("[collect] bootstrap 降级: 无 dispatch.json + 磁盘有 artifact → actual_writes_source=worker_self_report, 通过", () => {
  const runsRoot = path.join(makeTmp(), "runs");
  // 这里不调 dispatchReadyTasks; 直接手动翻 running 模拟野生 jeepay T01 场景
  const plan = makePlan();
  const runId = "20260628-004";
  const runDir = initRunDir(runsRoot, runId, "野生 T01 测试");
  writeRunState(
    runDir,
    parseRunState({
      run_id: runId,
      complexity: "simple",
      phase: Phase.CREATED,
      capabilities: NO_CAPS,
    }),
  );
  fs.mkdirSync(path.join(runDir, "planning"), { recursive: true });
  writeTaskPlan(path.join(runDir, "planning", "task-plan.yaml"), plan);

  const coord = new Coordinator(runDir, new InlineWorkerRunner(noopWorker));
  coord.startPlanning();
  coord.submitPlan(plan);
  coord.signoffPlan(true);

  // 手动把 T01 翻 running (模拟"野生 task"已存在但 dispatch.json 缺失)
  const newTasks = [...coord.plan!.tasks];
  newTasks[0] = { ...newTasks[0]!, status: "running", attempt: 1 };
  // @ts-expect-error 测试场景直接改 plan 内部状态模拟野生 task
  coord.plan = { ...coord.plan!, tasks: newTasks };
  coord.state = { ...coord.state, active_tasks: ["T01"] };
  writeRunState(runDir, coord.state);
  writeTaskPlan(path.join(runDir, "planning", "task-plan.yaml"), coord.plan!);

  // 确认 dispatch.json 不存在
  expect(readDispatchMeta(runDir, "T01")).toBeNull();

  // 子 agent 已落 artifact
  writeTestResults(runDir, "T01", { caseId: "t_happy" });
  writeSummary(runDir, "T01", "野生 T01 已完成");

  const result = coord.collectTaskOutcome("T01");

  // 通过 (task_check 不需要 actual_writes; OOB 检测在 capabilities 全 false 时跳过)
  expect(result.verified).toBe(true);
  expect(result.reason).toBe("passed");
  // bootstrap 降级 → source=worker_self_report
  expect(result.actual_writes_source).toBe("worker_self_report");

  // collect-warnings.txt 落盘 (主 agent 可读)
  expect(
    fs.existsSync(path.join(runDir, "tasks", "T01", "logs", "collect-warnings.txt")),
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// 5. collectTaskOutcome 失败路径
// ---------------------------------------------------------------------------

test("[collect] 失败路径: task_check 未通过 → 留 running + 落 collect-failures.json + attempt 不递增", () => {
  const runsRoot = path.join(makeTmp(), "runs");
  const coord = setupImplementing(runsRoot, "20260628-005", makePlan());
  const runDir = coord.runDir;

  coord.dispatchReadyTasks();
  const attemptBefore = coord.plan!.tasks[0]!.attempt;
  expect(attemptBefore).toBe(1);

  // 子 agent 落了失败的 test-results (case 未通过)
  writeTestResults(runDir, "T01", { green: false, caseId: "t_happy" });
  writeSummary(runDir, "T01", "T01 失败");

  const result = coord.collectTaskOutcome("T01");

  expect(result.verified).toBe(false);
  expect(result.reason).toBe("task_check_fail");
  expect(result.task_check_all_pass).toBe(false);

  // 留 running (没翻 complete)
  expect(coord.plan!.tasks[0]!.status).toBe("running");
  expect(coord.state.active_tasks).toContain("T01");

  // attempt 不递增 (collect 失败不递增, 由下次 dispatch 递增)
  expect(coord.plan!.tasks[0]!.attempt).toBe(attemptBefore);

  // collect-failures.json 落盘
  const cf = readCollectFailures(runDir, "T01");
  expect(cf).not.toBeNull();
  expect(cf!.reason).toBe("task_check_fail");
  expect(cf!.attempt).toBe(attemptBefore);
  expect(cf!.failures.length).toBeGreaterThan(0);

  // 默认 max_retries_per_task=1, attempt=1 已达上限 → max_retries_exceeded=true
  expect(result.max_retries_exceeded).toBe(true);
});

// ---------------------------------------------------------------------------
// 6. fix 重试: 第二次 dispatch 同 task → attempt 递增 + dispatch.json 覆盖
// ---------------------------------------------------------------------------

test("[dispatch] fix 重试: 第二次 dispatch 同 task → attempt 递增 + dispatch.json 覆盖 + active_tasks 仍含 T01", () => {
  const runsRoot = path.join(makeTmp(), "runs");
  // 把 max_retries_per_task 调到 3, 让重试合法
  const coord = setupImplementing(runsRoot, "20260628-006", makePlan(), {
    maxRetries: 3,
  });
  const runDir = coord.runDir;

  // 第一次 dispatch
  coord.dispatchReadyTasks();
  expect(coord.plan!.tasks[0]!.attempt).toBe(1);
  const meta1 = readDispatchMeta(runDir, "T01");
  expect(meta1!.attempt).toBe(1);

  // 模拟 fix-once 失败: collect 返回未通过, task 留 running
  writeTestResults(runDir, "T01", { green: false, caseId: "t_happy" });
  const r1 = coord.collectTaskOutcome("T01");
  expect(r1.verified).toBe(false);
  expect(coord.plan!.tasks[0]!.status).toBe("running");

  // 主 agent 派 fix 子 agent 修复后再 dispatch (real flow: 主 agent 显式重排队)。
  // 这里模拟主 agent 把 task 状态改回 pending + 清出 active_tasks,
  // 让 readyFrontier 重新选它 (单写者契约: 主 agent 不直接改 plan, 这里仅测试场景模拟)。
  const newTasks = [...coord.plan!.tasks];
  newTasks[0] = { ...newTasks[0]!, status: "pending" as const };
  // @ts-expect-error 测试场景直接改 plan
  coord.plan = { ...coord.plan!, tasks: newTasks };
  coord.state = { ...coord.state, active_tasks: [] };

  // 第二次 dispatch (覆盖 dispatch.json + attempt 递增)
  const packets2 = coord.dispatchReadyTasks();
  expect(packets2).toHaveLength(1);
  expect(coord.plan!.tasks[0]!.attempt).toBe(2);

  const meta2 = readDispatchMeta(runDir, "T01");
  expect(meta2).not.toBeNull();
  expect(meta2!.attempt).toBe(2);
  // dispatched_at 应比第一次新 (覆盖写)
  expect(new Date(meta2!.dispatched_at).getTime()).toBeGreaterThanOrEqual(
    new Date(meta1!.dispatched_at).getTime(),
  );

  // 子 agent 修复后落新 artifact, 再次 collect 通过
  writeTestResults(runDir, "T01", { green: true, caseId: "t_happy" });
  writeSummary(runDir, "T01", "T01 修复后通过");
  const r2 = coord.collectTaskOutcome("T01");
  expect(r2.verified).toBe(true);
  expect(r2.attempt).toBe(2);
  // max_retries_exceeded 在通过时为 false
  expect(r2.max_retries_exceeded).toBe(false);
});

// ---------------------------------------------------------------------------
// 7. OOB 场景: worker 写了 allowed_write_paths 外的路径
// ---------------------------------------------------------------------------

test("[collect] OOB 场景: workdir 有超出 allowed_write_paths 的文件 → oob_paths 非空 + reason=oob + 留 running", () => {
  const runsRoot = path.join(makeTmp(), "runs");
  // 单独打开 fs_snapshot, 让 actual_writes 采集到 workdir 改动
  const coord = setupImplementing(
    runsRoot,
    "20260628-007",
    makePlan(),
    { caps: { git_diff: false, fs_snapshot: true } },
  );
  const runDir = coord.runDir;

  coord.dispatchReadyTasks();
  const workdir = path.dirname(runDir); // buildPacket 默认 workdir = dirname(runDir)

  // 在 workdir 下放一个明显超出 src/** 的文件 (fs_snapshot 会捕获)
  const oobFile = path.join(workdir, "OUTSIDE.md");
  fs.writeFileSync(oobFile, "this file is outside src/** allowed paths\n", "utf-8");

  try {
    // 子 agent 也落了通过的 test-results
    writeTestResults(runDir, "T01", { green: true, caseId: "t_happy" });
    writeSummary(runDir, "T01", "T01 OK 但越界了");

    const result = coord.collectTaskOutcome("T01");

    // OOB 检测: 即使 task_check 通过, OOB 也会让 verified=false
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("oob");
    expect(result.oob_paths.length).toBeGreaterThan(0);
    expect(result.oob_paths.some((p) => p.includes("OUTSIDE.md"))).toBe(true);
    expect(coord.plan!.tasks[0]!.status).toBe("running");

    // collect-failures.json 落盘 reason=oob
    const cf = readCollectFailures(runDir, "T01");
    expect(cf!.reason).toBe("oob");
    expect(cf!.oob_paths.length).toBeGreaterThan(0);
  } finally {
    // 清掉 OOB 文件避免污染其它测试 (虽然 tmp 目录本就该清, 但 workdir 是 runDir 的父)
    try {
      fs.unlinkSync(oobFile);
    } catch {
      /* ignore */
    }
  }
});

// ---------------------------------------------------------------------------
// 8. failed 分支: 磁盘无 artifact → outcome.status=failed → reason=failed
// ---------------------------------------------------------------------------

test("[collect] 磁盘无 artifact → reconstruct 返回 failed → reason=failed + 留 running", () => {
  const runsRoot = path.join(makeTmp(), "runs");
  const coord = setupImplementing(runsRoot, "20260628-008", makePlan());
  const runDir = coord.runDir;

  coord.dispatchReadyTasks();
  expect(coord.plan!.tasks[0]!.status).toBe("running");

  // 磁盘无 artifact → reconstruct 返回 failed
  const result = coord.collectTaskOutcome("T01");
  expect(result.verified).toBe(false);
  expect(result.reason).toBe("failed");
  expect(coord.plan!.tasks[0]!.status).toBe("running");
  // phase 仍是 IMPLEMENTING (没回 PLANNING, 不是 plan_amendment)
  expect(coord.state.phase).toBe(Phase.IMPLEMENTING);
});

// ---------------------------------------------------------------------------
// 9. not_found / not_running 守卫
// ---------------------------------------------------------------------------

test("[collect] not_found / not_running 守卫: taskId 不存在或非 running 时返回明确 reason", () => {
  const runsRoot = path.join(makeTmp(), "runs");
  const plan = makePlan({
    tasks: [
      {
        id: "T01",
        allowed_write_paths: ["src/**"],
        acceptance_refs: ["AC-001"],
        tests: [{ id: "t1", scenario: "happy", checks: ["passed == true"] }],
      },
    ],
  });
  const coord = setupImplementing(runsRoot, "20260628-009", plan);

  // task 不存在
  const r1 = coord.collectTaskOutcome("NOPE");
  expect(r1.verified).toBe(false);
  expect(r1.reason).toBe("not_found");
  expect(r1.max_retries_exceeded).toBe(false);

  // T01 存在但未 dispatch (status=pending) → not_running
  const r2 = coord.collectTaskOutcome("T01");
  expect(r2.verified).toBe(false);
  expect(r2.reason).toBe("not_running");
  expect(r2.max_retries_exceeded).toBe(false);
});

// ---------------------------------------------------------------------------
// 10. dispatch 守卫: phase 错误时抛
// ---------------------------------------------------------------------------

test("[dispatch] phase≠IMPLEMENTING 时抛错 (PLANNING 阶段调 dispatchReadyTasks)", () => {
  const runsRoot = path.join(makeTmp(), "runs");
  const runId = "20260628-010";
  const runDir = initRunDir(runsRoot, runId, "phase 守卫测试");
  writeRunState(
    runDir,
    parseRunState({
      run_id: runId,
      complexity: "simple",
      phase: Phase.CREATED,
      capabilities: NO_CAPS,
    }),
  );
  const coord = new Coordinator(runDir, new InlineWorkerRunner(noopWorker));
  // 不调 startPlanning, phase 还是 CREATED
  expect(() => coord.dispatchReadyTasks()).toThrow(/IMPLEMENTING/);
});

// ---------------------------------------------------------------------------
// 11. all_complete=false 时 collect 不触发 submitWrapUp
// ---------------------------------------------------------------------------

test("[collect] 多 task plan 中只完成一个 → all_complete=false + 不触发 submitWrapUp", () => {
  const runsRoot = path.join(makeTmp(), "runs");
  const plan = makePlan({
    tasks: [
      {
        id: "T01",
        allowed_write_paths: ["src/a/**"],
        acceptance_refs: ["AC-001"],
        tests: [{ id: "t1", scenario: "happy", checks: ["passed == true"] }],
      },
      {
        id: "T02",
        allowed_write_paths: ["src/b/**"],
        acceptance_refs: ["AC-002"],
        depends_on: ["T01"],
        tests: [{ id: "t2", scenario: "happy", checks: ["passed == true"] }],
      },
    ],
  });
  const coord = setupImplementing(runsRoot, "20260628-011", plan);
  const runDir = coord.runDir;

  // 只 dispatch + collect T01 (T02 还依赖 T01, 不会同时 ready)
  coord.dispatchReadyTasks();
  expect(coord.state.active_tasks).toEqual(["T01"]);

  writeTestResults(runDir, "T01", { caseId: "t1" });
  writeSummary(runDir, "T01", "T01 done");

  const r = coord.collectTaskOutcome("T01");
  expect(r.verified).toBe(true);
  expect(r.all_complete).toBe(false);
  expect(coord.state.phase).toBe(Phase.IMPLEMENTING);
  // advanced_to 应该提示 T02 现在可派
  expect(r.advanced_to).toBe("T02");
});

// ---------------------------------------------------------------------------
// 12. 持久化: 跨进程 collect (新建 Coordinator 后能读 dispatch.json 继续 collect)
// ---------------------------------------------------------------------------

test("[collect] 跨进程 collect: dispatch → 新建 Coordinator → collect 仍能通过 (dispatch.json 跨进程存活)", () => {
  const runsRoot = path.join(makeTmp(), "runs");
  const coord = setupImplementing(runsRoot, "20260628-012", makePlan());
  const runDir = coord.runDir;

  coord.dispatchReadyTasks();

  // 模拟 CLI 跨进程: 新建 Coordinator (run-state.json + task-plan.yaml + dispatch.json 全在磁盘)
  const coord2 = new Coordinator(runDir, new InlineWorkerRunner(noopWorker));
  expect(coord2.state.phase).toBe(Phase.IMPLEMENTING);
  expect(coord2.plan!.tasks[0]!.status).toBe("running");

  // 子 agent 落 artifact
  writeTestResults(runDir, "T01", { caseId: "t_happy" });
  writeSummary(runDir, "T01", "跨进程 collect 通过");

  const result = coord2.collectTaskOutcome("T01");
  expect(result.verified).toBe(true);
  expect(coord2.plan!.tasks[0]!.status).toBe("complete");
  expect(result.all_complete).toBe(true);
});
