/**
 * 集成 dry-run 测试 (端到端验证 simple 档闭环, 用 RecordingWorkerRunner, 不打真实 LLM)。
 *
 * 行为权威: Python `tests/test_integration_dry_run.py` (333 行, 6 个端到端测试)。
 * 被测实现:
 *   - packages/ssot-ts/src/runtime/coordinator.ts (状态机 + tick 循环 + 收口/签收/中止/amend)
 *   - packages/cli/dist/index.js (P5-M7B 算法 dry-run 子命令, 经 CLI 入口的端到端探针)
 *
 * 7 个测试:
 * 1. test_end_to_end_simple_run —— CREATED→PLANNING→IMPLEMENTING→WRAPPING_UP→COMPLETE
 * 2. test_abort_during_planning —— abort → ABORTED, run-state.json 含 aborted_at/reason
 * 3. test_plan_amendment_during_implementing —— worker 返回 plan_amendment → 回滚 + 回 PLANNING
 * 4. test_hard_gate_task_missing_key_diffs_blocks_complete —— risk:high 缺 key-diffs → 收口 fail
 * 5. test_watchdog_recycle_after_timeout —— worker 超时 → recycle, attempt+1
 * 6. test_trust_mode_refuses_unattended —— switchTrustMode → TrustModeSwitchRefused
 * 7. [CLI 入口端到端] 经构建后的 CLI bundle 跑 init→plan→signoff-plan→run, 断言产物落盘 + phase 迁移
 *
 * 注: 端到端的 COMPLETE 闭环 (1) 直接驱动 Coordinator —— 与 Python 集成测试一致, 因为
 * CLI 的 echo 占位 worker 返回空 case, 无法满足"planned 用例需有结果"的任务自检 (这是占位
 * worker 的固有限制, Python CLI 同此, 见 tests/fixtures/smoke/runs 样例也停在 IMPLEMENTING)。
 * 故测试 7 经 CLI 入口断言到 IMPLEMENTING 这一段, 完整 COMPLETE 闭环由测试 1 经 runtime 覆盖。
 */
import { test, expect, beforeAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, execFileSync } from "node:child_process";

import {
  Coordinator,
  initRunDir,
  readRunState,
  writeRunState,
} from "../packages/ssot-ts/src/runtime/index.js";
import {
  RecordingWorkerRunner,
  makeWorkerOutcome,
} from "../packages/ssot-ts/src/dispatch/index.js";
import type { WorkerOutcome } from "../packages/ssot-ts/src/dispatch/index.js";
import {
  HumanPending,
  Phase,
  TrustMode,
  parseRunState,
} from "../packages/ssot-ts/src/schema/run_state.js";
import { parseTaskPlan } from "../packages/ssot-ts/src/schema/task_plan.js";
import type { TaskPlan } from "../packages/ssot-ts/src/schema/task_plan.js";
import {
  TrustModeSwitchRefused,
  switchTrustMode,
} from "../packages/ssot-ts/src/trust_mode/index.js";

const COMPLEXITY_SIMPLE = "simple";

/** 临时 runs 根目录 (用后即清)。 */
function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loop-dryrun-"));
}

/**
 * 建一个 run_dir + 写 CREATED 状态 (所有 runtime 测试的起点, 等价 Python `_make_run_dir`)。
 *
 * 注入 `config.require_plan_signoff=true`: 干净 simple plan 默认已免签直进 IMPLEMENTING,
 * 这些 runtime 测试目的是下游流程 (端到端/plan-amendment/watchdog 等), 显式 opt-out
 * 保留 submitPlan → plan_signoff → signoffPlan(true) 序列不变 (非免签本身的测试)。
 */
function makeRunDir(): string {
  const runsRoot = path.join(makeTmp(), "runs");
  const runId = "20260627-001";
  const runDir = initRunDir(runsRoot, runId, "test requirement");
  writeRunState(
    runDir,
    parseRunState({
      run_id: runId,
      complexity: COMPLEXITY_SIMPLE,
      phase: Phase.CREATED,
      config: { require_plan_signoff: true },
    }),
  );
  return runDir;
}

/**
 * 构造 minimal plan: 1 task, 1 AC, 1 happy-path test (等价 Python `_simple_plan`)。
 * riskHigh=true → task.risk=high (触发 key-diffs 硬 gate)。
 */
function simplePlan(opts?: { riskHigh?: boolean; withTests?: boolean }): TaskPlan {
  const riskHigh = opts?.riskHigh ?? false;
  const withTests = opts?.withTests ?? true;
  return parseTaskPlan({
    complexity: COMPLEXITY_SIMPLE,
    tasks: [
      {
        id: "T01",
        title: "simple task",
        allowed_write_paths: ["src/**"],
        acceptance_refs: ["AC-001"],
        depends_on: [],
        risk: riskHigh ? "high" : "normal",
        tests: withTests
          ? [{ id: "t1_happy", scenario: "happy path", checks: ["passed == true"] }]
          : [],
      },
    ],
  });
}

/**
 * 构造 completed outcome (tests_green=true, 1 个 passed case) (等价 Python `_completed_outcome`)。
 * withKeyDiffs=true → 附带非空 key-diffs.yaml。
 */
function completedOutcome(opts?: { withKeyDiffs?: boolean; taskId?: string }): WorkerOutcome {
  const withKeyDiffs = opts?.withKeyDiffs ?? false;
  const taskId = opts?.taskId ?? "T01";
  return makeWorkerOutcome({
    status: "completed",
    test_results: {
      tests_green: true,
      cases: [{ id: "t1_happy", passed: true, failure_reason: "" }],
    },
    summary_text: "done",
    key_diffs_file: withKeyDiffs
      ? {
          schema: "loop-engineering.key-diffs.v1",
          task_id: taskId,
          key_diffs: [{ file: "src/x.ts", change: "add x", why: "for AC-001", risk: "low" }],
        }
      : null,
  });
}

// ---------------------------------------------------------------------------
// 1. 端到端 simple run
// ---------------------------------------------------------------------------

test("[py: test_end_to_end_simple_run] CREATED→PLANNING→IMPLEMENTING→WRAPPING_UP→COMPLETE 闭环", () => {
  const runDir = makeRunDir();
  // 预置 worker outcome: completed, tests_green, 带非空 key-diffs (满足 key-diffs gate)。
  const runner = new RecordingWorkerRunner([completedOutcome({ withKeyDiffs: true })]);
  const coord = new Coordinator(runDir, runner);

  // 1. CREATED → PLANNING
  coord.startPlanning();
  expect(coord.state.phase).toBe(Phase.PLANNING);

  // 2. 提交 plan + signoff
  coord.submitPlan(simplePlan());
  expect(coord.state.human_pending).toBe(HumanPending.plan_signoff);
  coord.signoffPlan(true);
  expect(coord.state.phase).toBe(Phase.IMPLEMENTING);
  expect(coord.state.human_pending ?? null).toBeNull();

  // 3. 跑 tick 循环 → task complete + 普通全绿自动直达 COMPLETE (无 wrap_up_signoff)
  coord.runUntilHumanOrTerminal(10);
  expect(coord.plan).not.toBeNull();
  expect(coord.plan!.tasks[0]!.status).toBe("complete");
  expect(coord.state.phase).toBe(Phase.COMPLETE);
  expect(coord.state.human_pending ?? null).toBeNull();

  // 4. 收口自检仍跑 → check-result.json 含 all_tasks_tests_green
  const result = fs.readFileSync(path.join(runDir, "wrap-up", "check-result.json"), "utf-8");
  expect(result).toContain("all_tasks_tests_green");

  // 5. run-state.json 持久化为 COMPLETE
  const persisted = readRunState(runDir);
  expect(persisted.phase).toBe(Phase.COMPLETE);

  // 产物落盘断言: tasks/T01/{summary.md, key-diffs.yaml} + wrap-up/check-result.json
  expect(fs.existsSync(path.join(runDir, "tasks", "T01", "summary.md"))).toBe(true);
  expect(fs.existsSync(path.join(runDir, "tasks", "T01", "key-diffs.yaml"))).toBe(true);
  expect(fs.existsSync(path.join(runDir, "planning", "task-plan.yaml"))).toBe(true);
});

// ---------------------------------------------------------------------------
// 2. abort during planning
// ---------------------------------------------------------------------------

test("[py: test_abort_during_planning] PLANNING abort → ABORTED + aborted_at/reason 持久化", () => {
  const runDir = makeRunDir();
  const coord = new Coordinator(runDir, new RecordingWorkerRunner([]));
  coord.startPlanning();
  expect(coord.state.phase).toBe(Phase.PLANNING);

  coord.abort("人主动放弃 (test)");
  expect(coord.state.phase).toBe(Phase.ABORTED);
  expect(coord.state.aborted_at).not.toBeNull();
  expect(coord.state.aborted_reason).toBe("人主动放弃 (test)");

  const persisted = readRunState(runDir);
  expect(persisted.phase).toBe(Phase.ABORTED);
  expect(persisted.aborted_reason).toBe("人主动放弃 (test)");
  expect(persisted.aborted_at).not.toBeNull();
});

// ---------------------------------------------------------------------------
// 3. plan amendment during implementing
// ---------------------------------------------------------------------------

test("[py: test_plan_amendment_during_implementing] worker 返回 plan_amendment → 回滚 + 回 PLANNING", () => {
  const runDir = makeRunDir();
  const amendment = {
    status: "plan-amendment-needed" as const,
    reason: "planned 用例 t1_happy 在实际代码中不可执行",
    touched_acceptance_refs: ["AC-001"],
  };
  const runner = new RecordingWorkerRunner([
    makeWorkerOutcome({ status: "plan_amendment", plan_amendment: amendment }),
  ]);
  const coord = new Coordinator(runDir, runner);
  coord.startPlanning();
  coord.submitPlan(simplePlan());
  coord.signoffPlan(true);
  expect(coord.state.phase).toBe(Phase.IMPLEMENTING);

  // 跑一次 tick, worker 会返回 plan_amendment
  coord.runTick();

  // coordinator 应已 computeRollback + apply (T01 回 pending) + 回 PLANNING + 等 signoff
  expect(coord.state.phase).toBe(Phase.PLANNING);
  expect(coord.state.human_pending).toBe(HumanPending.plan_signoff);
  expect(coord.plan).not.toBeNull();
  expect(coord.plan!.tasks[0]!.status).toBe("pending");
});

// ---------------------------------------------------------------------------
// 4. hard gate task missing key-diffs blocks COMPLETE
// ---------------------------------------------------------------------------

test("[py: test_hard_gate_task_missing_key_diffs_blocks_complete] risk:high 缺 key-diffs → 收口自检 fail", () => {
  const runDir = makeRunDir();
  // completed outcome 但不带 key-diffs
  const runner = new RecordingWorkerRunner([completedOutcome({ withKeyDiffs: false })]);
  const coord = new Coordinator(runDir, runner);
  coord.startPlanning();
  coord.submitPlan(simplePlan({ riskHigh: true })); // risk:high → 触发硬 gate
  coord.signoffPlan(true);

  coord.runUntilHumanOrTerminal(10);

  // task 自检通过 (tests_green), 但 key-diffs 硬 gate 缺 → 收口自检 fail。
  // §A4: 收口失败也 set human_pending=wrap_up_signoff, 让 runUntilHumanOrTerminal 退出循环。
  expect(coord.state.phase).toBe(Phase.WRAPPING_UP);
  expect(coord.state.human_pending).toBe(HumanPending.wrap_up_signoff);

  // wrap-up/check-result.json 应含 all_hard_gates_pass = false
  const result = fs.readFileSync(path.join(runDir, "wrap-up", "check-result.json"), "utf-8");
  expect(result).toContain("all_hard_gates_pass");
  const items = JSON.parse(result) as Array<{ check: string; passed: boolean }>;
  const hardGate = items.find((i) => i.check === "all_hard_gates_pass")!;
  expect(hardGate.passed).toBe(false);

  // 校验未通过时, accepted 签收被拒绝 (signoffWrapUp(true) 抛错)。
  expect(() => coord.signoffWrapUp(true)).toThrow();
});

// ---------------------------------------------------------------------------
// 5. watchdog recycle after timeout
// ---------------------------------------------------------------------------

test("[py: test_watchdog_recycle_after_timeout] worker 超时 → watchdog recycle, attempt+1", () => {
  const runDir = makeRunDir();
  // 派一个失败的 outcome (自检不通过 → 留 running), 再让 watchdog 判 stale 回收。
  const badOutcome = makeWorkerOutcome({
    status: "completed",
    test_results: { tests_green: false, cases: [] },
  });
  // 预置两个 bad outcome: 第一次派发 + recycle 后第二次派发都用得上。
  const runner = new RecordingWorkerRunner([badOutcome, badOutcome]);
  const coord = new Coordinator(runDir, runner);
  coord.startPlanning();
  coord.submitPlan(simplePlan());
  coord.signoffPlan(true);

  // 跑一次 tick: worker 交回但自检不通过 → 留 running
  coord.runTick();
  expect(coord.plan).not.toBeNull();
  expect(coord.plan!.tasks[0]!.status).toBe("running");
  expect(coord.startedAtByTask.has("T01")).toBe(true);

  // 手动把 started_at 改成超时之前 (simple 档默认 15 min)
  coord.startedAtByTask.set("T01", new Date(Date.now() - 30 * 60 * 1000));

  // 再跑一次 tick: watchdog 应判 stale 并 recycle, attempt 已 +1, stale_count +1。
  coord.runTick();

  const t = coord.plan!.tasks[0]!;
  expect(t.attempt).toBe(1);
  expect(coord.staleCountByTask.get("T01")).toBe(1);

  // watchdog.json 应有一条 timeout 事件
  const wdPath = path.join(runDir, "tasks", "T01", "logs", "watchdog.json");
  expect(fs.existsSync(wdPath)).toBe(true);
  const events = JSON.parse(fs.readFileSync(wdPath, "utf-8")) as Array<{ reason: string }>;
  expect(events.some((e) => e.reason === "timeout")).toBe(true);
});

// ---------------------------------------------------------------------------
// 6. trust_mode refuses unattended
// ---------------------------------------------------------------------------

test("[py: test_trust_mode_refuses_unattended] switchTrustMode → TrustModeSwitchRefused", () => {
  const runDir = makeRunDir();
  const coord = new Coordinator(runDir, new RecordingWorkerRunner([]));

  expect(() => switchTrustMode(coord.state, TrustMode.unattended)).toThrow(
    TrustModeSwitchRefused,
  );

  // 仍可降档到 collaborative (无 gate)
  const newState = switchTrustMode(coord.state, TrustMode.collaborative);
  expect(newState.trust_mode).toBe(TrustMode.collaborative);
});

// ---------------------------------------------------------------------------
// 7. CLI 入口端到端 (经构建后的 dist/index.js)
// ---------------------------------------------------------------------------

/** 从测试文件位置定位仓库根 (tests-ts/ 直属仓库根)。 */
function resolveRepoRoot(): string {
  const candidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    process.cwd(),
  ];
  for (const c of candidates) {
    if (
      fs.existsSync(path.join(c, "core", "manifest.json")) &&
      fs.existsSync(path.join(c, "packages", "cli"))
    ) {
      return c;
    }
  }
  throw new Error(`无法定位仓库根 (尝试: ${candidates.join(", ")})`);
}

const REPO_ROOT = resolveRepoRoot();
const CLI_BUNDLE = path.join(REPO_ROOT, "packages", "cli", "dist", "index.js");
// 夹具自包含于 tests-ts/ (不依赖已归档的 Python tests/ 树)。
const SMOKE = path.join(REPO_ROOT, "tests-ts", "fixtures", "smoke");

beforeAll(() => {
  // 确保 cli/dist 是最新产物 (含 P5-M7B dry-run 子命令 + zod bundle)。
  execSync("npm run build", { cwd: REPO_ROOT, stdio: "pipe" });
}, 30000);

test("[CLI 入口端到端] node 跑 dist/index.js: init→plan→signoff-plan→run, 产物落盘 + phase 迁移", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "loop-cli-e2e-"));
  try {
    const reqPath = path.join(SMOKE, "req.md");
    const designPath = path.join(SMOKE, "design.md");
    const planPath = path.join(SMOKE, "task-plan.yaml");
    const runsRoot = path.join(work, "runs");

    const run = (...argv: string[]): string =>
      execFileSync(process.execPath, [CLI_BUNDLE, ...argv, "--runs-root", runsRoot], {
        cwd: work,
        encoding: "utf-8",
      });

    // init → CREATED, 解析 run_id
    const initOut = run("init", reqPath, "--worktree-mode", "none");
    const m = initOut.match(/created run: (\d{8}-\d{3})/);
    expect(m).not.toBeNull();
    const runId = m![1]!;
    const runDir = path.join(runsRoot, runId);
    expect(fs.existsSync(path.join(runDir, "run-state.json"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "input", "requirement.md"))).toBe(true);
    expect(readRunState(runDir).phase).toBe(Phase.CREATED);

    // plan → 干净 simple 免签直进 IMPLEMENTING, stdout 含 auto-accepted, 无 plan_signoff。
    // design/task-plan + plan-auto-accepted.json 落盘。
    const planOut = run("plan", runId, "--design", designPath, "--task-plan", planPath);
    expect(planOut).toContain("phase=IMPLEMENTING");
    expect(planOut).toContain("auto-accepted");
    expect(fs.existsSync(path.join(runDir, "planning", "design.md"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "planning", "task-plan.yaml"))).toBe(true);
    expect(
      fs.existsSync(path.join(runDir, "planning", "plan-auto-accepted.json")),
    ).toBe(true);
    expect(readRunState(runDir).phase).toBe(Phase.IMPLEMENTING);
    expect(readRunState(runDir).human_pending ?? null).toBeNull();

    // run → tick 循环 (echo 占位 worker 不满足 planned case, 停在 IMPLEMENTING, 与 Python CLI 一致)
    const runOut = run("run", runId);
    expect(runOut).toContain("循环结束");
    expect(readRunState(runDir).phase).toBe(Phase.IMPLEMENTING);

    // status → 经 CLI 入口可读回 phase
    const statusOut = run("status", runId);
    expect(statusOut).toContain("phase: IMPLEMENTING");
    expect(statusOut).toContain("navigation_map:");
    expect(statusOut).toContain("IMPLEMENTING:");
    expect(statusOut).toContain("next_action:");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8. CLI opt-out: init --require-plan-signoff → 干净 simple plan 仍停 plan 门禁
// ---------------------------------------------------------------------------

test("[CLI 入口 opt-out] init --require-plan-signoff → plan 后仍 PLANNING + plan_signoff (不免签)", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "loop-cli-optout-"));
  try {
    const reqPath = path.join(SMOKE, "req.md");
    const designPath = path.join(SMOKE, "design.md");
    const planPath = path.join(SMOKE, "task-plan.yaml");
    const runsRoot = path.join(work, "runs");

    const run = (...argv: string[]): string =>
      execFileSync(process.execPath, [CLI_BUNDLE, ...argv, "--runs-root", runsRoot], {
        cwd: work,
        encoding: "utf-8",
      });

    // init --require-plan-signoff → CREATED, config.require_plan_signoff=true
    const initOut = run("init", reqPath, "--worktree-mode", "none", "--require-plan-signoff");
    const runId = initOut.match(/created run: (\d{8}-\d{3})/)![1]!;
    const runDir = path.join(runsRoot, runId);
    // config 写入校验: run-state.json 含 require_plan_signoff=true
    const rawState = JSON.parse(
      fs.readFileSync(path.join(runDir, "run-state.json"), "utf-8"),
    ) as { config?: { require_plan_signoff?: boolean } };
    expect(rawState.config?.require_plan_signoff).toBe(true);

    // plan → opt-out 拉回门禁: 仍 PLANNING + plan_signoff, 无 plan-auto-accepted.json
    const planOut = run("plan", runId, "--design", designPath, "--task-plan", planPath);
    expect(planOut).toContain("human_pending=plan_signoff");
    expect(planOut).not.toContain("auto-accepted");
    expect(readRunState(runDir).phase).toBe(Phase.PLANNING);
    expect(readRunState(runDir).human_pending).toBe(HumanPending.plan_signoff);
    expect(
      fs.existsSync(path.join(runDir, "planning", "plan-auto-accepted.json")),
    ).toBe(false);

    // signoff-plan → IMPLEMENTING (opt-out 后人工门禁流程仍可推进)
    const spOut = run("signoff-plan", runId);
    expect(spOut).toContain("accepted");
    expect(readRunState(runDir).phase).toBe(Phase.IMPLEMENTING);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
