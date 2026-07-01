/**
 * guard_anchors (Hook C / Stop) 等价测试。
 *
 * 行为权威: Python `loop_engineering/hooks/loop_engineering/guard_anchors.py`
 * 用例源: Python `tests/test_hooks_smoke.py::TestGuardAnchors` + logic.ts 用例清单
 *
 * TS ↔ Python decision 语义映射 (见 packages/shared/src/types.ts 注释):
 *   - TS decision="allow" ↔ Python emit_pass_silent (静默放行)
 *   - TS decision="deny"  ↔ Python emit_block (拒绝, block)
 *
 * guard_anchors 的 fail-safe = deny (与 probe_and_gate 的 fail-safe=放行 相反)。
 *
 * 隔离策略: 每个用例用独立 os.tmpdir() repoRoot + 独立 runs/, 通过 LOOP_RUNS_ROOT 定位,
 * 不同用例 runDir 不同, 避免串台。
 */

import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleGuardAnchors, type HookInput } from "@e2e-loop/shared";

// ---------------------------------------------------------------------------
// 临时夹具工具
// ---------------------------------------------------------------------------

const _toClean: string[] = [];
const _envBackup = process.env.LOOP_RUNS_ROOT;

afterEach(() => {
  if (_envBackup === undefined) delete process.env.LOOP_RUNS_ROOT;
  else process.env.LOOP_RUNS_ROOT = _envBackup;
  while (_toClean.length) {
    const d = _toClean.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响断言 */
    }
  }
});

function makeRepoRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-anchors-${label}-`));
  _toClean.push(root);
  return root;
}

/**
 * 建 runs/<runId>/, 写 run-state.json + (可选) task-plan.yaml, 设 LOOP_RUNS_ROOT。
 * 返回 runDir。
 */
function makeRun(
  repoRoot: string,
  runId: string,
  state: Record<string, unknown>,
  planYaml?: string,
): string {
  const runsRoot = path.join(repoRoot, "runs");
  const runDir = path.join(runsRoot, runId);
  fs.mkdirSync(path.join(runDir, "planning"), { recursive: true });
  fs.mkdirSync(path.join(runDir, "tasks"), { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "run-state.json"),
    JSON.stringify(state),
    "utf-8",
  );
  if (planYaml !== undefined) {
    fs.writeFileSync(
      path.join(runDir, "planning", "task-plan.yaml"),
      planYaml,
      "utf-8",
    );
  }
  process.env.LOOP_RUNS_ROOT = runsRoot;
  return runDir;
}

/** 单 task t1 (status=running) 的 task-plan.yaml (与 Python tmp_run fixture 一致)。 */
const SINGLE_RUNNING_PLAN =
  "schema: loop-engineering.task-plan.v2\n" +
  "complexity: simple\n" +
  "tasks:\n" +
  "  - id: t1\n" +
  "    title: test task\n" +
  "    allowed_write_paths:\n" +
  "      - src/**\n" +
  "    acceptance_refs:\n" +
  "      - AC1\n" +
  "    status: running\n";

/** 写 tasks/<taskId>/test-results.yaml (含 tests_green)。 */
function writeTestResults(runDir: string, taskId: string, green: boolean): void {
  const dir = path.join(runDir, "tasks", taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "test-results.yaml"),
    `tests_green: ${green}\n`,
    "utf-8",
  );
}

function stopInput(cwd: string): HookInput {
  return { event: "Stop", cwd };
}

// ---------------------------------------------------------------------------
// 用例 1: 无活跃 run → allow
// (Python test_no_active_run_passes)
// ---------------------------------------------------------------------------

test("无活跃 run (runs/ 空) → allow", async () => {
  const repoRoot = makeRepoRoot("noactive");
  const runsRoot = path.join(repoRoot, "runs");
  fs.mkdirSync(runsRoot, { recursive: true });
  process.env.LOOP_RUNS_ROOT = runsRoot;

  const out = await handleGuardAnchors(stopInput(repoRoot));
  expect(out.decision).toBe("allow");
});

// ---------------------------------------------------------------------------
// 用例 2: phase=COMPLETE → allow (终态, findActiveRun 跳过 → 无活跃 run → allow)
// ---------------------------------------------------------------------------

test("phase=COMPLETE (终态) → allow", async () => {
  const repoRoot = makeRepoRoot("complete");
  makeRun(repoRoot, "20260101-001", {
    run_id: "20260101-001",
    phase: "COMPLETE",
    complexity: "simple",
    trust_mode: "collaborative",
    active_tasks: [],
  });

  const out = await handleGuardAnchors(stopInput(repoRoot));
  expect(out.decision).toBe("allow");
});

// ---------------------------------------------------------------------------
// 用例 3: human_pending=plan_signoff → allow (合法人锚点)
// (Python test_human_pending_passes)
// ---------------------------------------------------------------------------

test("human_pending=plan_signoff (PLANNING) → allow (合法人锚点)", async () => {
  const repoRoot = makeRepoRoot("plansign");
  makeRun(repoRoot, "20260101-001", {
    run_id: "20260101-001",
    phase: "PLANNING",
    complexity: "simple",
    trust_mode: "collaborative",
    human_pending: "plan_signoff",
    active_tasks: [],
  });

  const out = await handleGuardAnchors(stopInput(repoRoot));
  expect(out.decision).toBe("allow");
});

// ---------------------------------------------------------------------------
// 用例 4: human_pending=wrap_up_signoff → allow (合法人锚点)
// ---------------------------------------------------------------------------

test("human_pending=wrap_up_signoff (WRAPPING_UP) → allow (合法人锚点)", async () => {
  const repoRoot = makeRepoRoot("wrapsign");
  makeRun(repoRoot, "20260101-001", {
    run_id: "20260101-001",
    phase: "WRAPPING_UP",
    complexity: "simple",
    trust_mode: "collaborative",
    human_pending: "wrap_up_signoff",
    active_tasks: [],
  });

  const out = await handleGuardAnchors(stopInput(repoRoot));
  expect(out.decision).toBe("allow");
});

// ---------------------------------------------------------------------------
// 用例 5: IMPLEMENTING + 活跃 task test-results.yaml tests_green=true → allow
// ---------------------------------------------------------------------------

test("IMPLEMENTING + 活跃 task tests_green=true → allow (自检通过)", async () => {
  const repoRoot = makeRepoRoot("greenpass");
  const runDir = makeRun(
    repoRoot,
    "20260101-001",
    {
      run_id: "20260101-001",
      phase: "IMPLEMENTING",
      complexity: "simple",
      trust_mode: "collaborative",
      active_tasks: ["t1"],
    },
    SINGLE_RUNNING_PLAN,
  );
  writeTestResults(runDir, "t1", true);

  const out = await handleGuardAnchors(stopInput(repoRoot));
  expect(out.decision).toBe("allow");
});

// ---------------------------------------------------------------------------
// 用例 6: IMPLEMENTING + task running 但无 test-results.yaml → deny;
//         reason 含 "test-results.yaml" 和 "IMPLEMENTING"
// (Python test_implementing_no_test_results_blocks)
// ---------------------------------------------------------------------------

test("IMPLEMENTING + 无 test-results.yaml → deny, reason 含 test-results.yaml 与 IMPLEMENTING", async () => {
  const repoRoot = makeRepoRoot("notests");
  makeRun(
    repoRoot,
    "20260101-001",
    {
      run_id: "20260101-001",
      phase: "IMPLEMENTING",
      complexity: "simple",
      trust_mode: "collaborative",
      active_tasks: ["t1"],
    },
    SINGLE_RUNNING_PLAN,
  );
  // 不写 test-results.yaml

  const out = await handleGuardAnchors(stopInput(repoRoot));
  expect(out.decision).toBe("deny");
  const reason = out.reason ?? "";
  // Python 断言: "IMPLEMENTING" in reason 或 "tests_green" in reason;
  // TS detail 含 "test-results.yaml 未落盘", 顶层 reason 含 "phase=IMPLEMENTING"
  expect(reason).toContain("test-results.yaml");
  expect(reason).toContain("IMPLEMENTING");
});

// ---------------------------------------------------------------------------
// 用例 7: IMPLEMENTING + tests_green=false → deny; reason 含 "tests_green"
// ---------------------------------------------------------------------------

test("IMPLEMENTING + tests_green=false → deny, reason 含 tests_green", async () => {
  const repoRoot = makeRepoRoot("redtests");
  const runDir = makeRun(
    repoRoot,
    "20260101-001",
    {
      run_id: "20260101-001",
      phase: "IMPLEMENTING",
      complexity: "simple",
      trust_mode: "collaborative",
      active_tasks: ["t1"],
    },
    SINGLE_RUNNING_PLAN,
  );
  writeTestResults(runDir, "t1", false);

  const out = await handleGuardAnchors(stopInput(repoRoot));
  expect(out.decision).toBe("deny");
  expect(out.reason ?? "").toContain("tests_green");
});

// ---------------------------------------------------------------------------
// 用例 7b: IMPLEMENTING + test-results.yaml schema 不合法 (缺 tests_green) → deny
//          (checkImplementingPhase 内 readTestResultsGreen 抛 → ok:false → deny)
// ---------------------------------------------------------------------------

test("IMPLEMENTING + test-results.yaml 缺 tests_green 字段 → deny (解析失败)", async () => {
  const repoRoot = makeRepoRoot("badtests");
  const runDir = makeRun(
    repoRoot,
    "20260101-001",
    {
      run_id: "20260101-001",
      phase: "IMPLEMENTING",
      complexity: "simple",
      trust_mode: "collaborative",
      active_tasks: ["t1"],
    },
    SINGLE_RUNNING_PLAN,
  );
  // 写一个缺 tests_green 的 test-results.yaml
  const dir = path.join(runDir, "tasks", "t1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "test-results.yaml"),
    "some_other_field: 1\n",
    "utf-8",
  );

  const out = await handleGuardAnchors(stopInput(repoRoot));
  expect(out.decision).toBe("deny");
  expect(out.reason ?? "").toContain("解析失败");
});

// ---------------------------------------------------------------------------
// 用例 8: IMPLEMENTING + 无 running task + 全部 task complete → allow
// (合法边界: 所有 task 已完工, 可进 WRAPPING_UP)
// ---------------------------------------------------------------------------

test("IMPLEMENTING + 无 running task + 全 complete → allow", async () => {
  const repoRoot = makeRepoRoot("transition");
  const planAllComplete =
    "schema: loop-engineering.task-plan.v2\n" +
    "complexity: simple\n" +
    "tasks:\n" +
    "  - id: t1\n" +
    "    title: done task\n" +
    "    allowed_write_paths:\n" +
    "      - src/**\n" +
    "    acceptance_refs:\n" +
    "      - AC1\n" +
    "    status: complete\n";
  makeRun(
    repoRoot,
    "20260101-001",
    {
      run_id: "20260101-001",
      phase: "IMPLEMENTING",
      complexity: "simple",
      trust_mode: "collaborative",
      active_tasks: [],
    },
    planAllComplete,
  );

  const out = await handleGuardAnchors(stopInput(repoRoot));
  expect(out.decision).toBe("allow");
});

// ---------------------------------------------------------------------------
// 用例 8b: IMPLEMENTING + 无 running task + 存在 pending task → deny
// (派发前/任务间空档想结束回合: 还有活没干完, 不许早停)
// ---------------------------------------------------------------------------

test("IMPLEMENTING + 无 running task + 有 pending task → deny (未完工不许早停)", async () => {
  const repoRoot = makeRepoRoot("pendingleft");
  const planWithPending =
    "schema: loop-engineering.task-plan.v2\n" +
    "complexity: simple\n" +
    "tasks:\n" +
    "  - id: t1\n" +
    "    title: todo task\n" +
    "    allowed_write_paths:\n" +
    "      - src/**\n" +
    "    acceptance_refs:\n" +
    "      - AC1\n" +
    "    status: pending\n";
  makeRun(
    repoRoot,
    "20260101-001",
    {
      run_id: "20260101-001",
      phase: "IMPLEMENTING",
      complexity: "simple",
      trust_mode: "collaborative",
      active_tasks: [],
    },
    planWithPending,
  );

  const out = await handleGuardAnchors(stopInput(repoRoot));
  expect(out.decision).toBe("deny");
  const reason = (out as { reason?: string }).reason ?? "";
  // reason 应指出还有 pending task 待推进、不该结束回合
  expect(reason).toContain("pending");
  expect(reason).toContain("结束回合");
});

// ---------------------------------------------------------------------------
// 用例 8c: IMPLEMENTING + 无 running/pending task + 剩余全 blocked → deny
// (全部卡死: 请设人锚点或转 ABORTED, 不许静默结束回合)
// ---------------------------------------------------------------------------

test("IMPLEMENTING + 无 running/pending + 剩余全 blocked → deny", async () => {
  const repoRoot = makeRepoRoot("blockedleft");
  const planWithBlocked =
    "schema: loop-engineering.task-plan.v2\n" +
    "complexity: simple\n" +
    "tasks:\n" +
    "  - id: t1\n" +
    "    title: blocked task\n" +
    "    allowed_write_paths:\n" +
    "      - src/**\n" +
    "    acceptance_refs:\n" +
    "      - AC1\n" +
    "    status: blocked\n";
  makeRun(
    repoRoot,
    "20260101-001",
    {
      run_id: "20260101-001",
      phase: "IMPLEMENTING",
      complexity: "simple",
      trust_mode: "collaborative",
      active_tasks: [],
    },
    planWithBlocked,
  );

  const out = await handleGuardAnchors(stopInput(repoRoot));
  expect(out.decision).toBe("deny");
  const reason = (out as { reason?: string }).reason ?? "";
  expect(reason).toContain("blocked");
});

// ---------------------------------------------------------------------------
// 用例 8d: simple 免签后 IMPLEMENTING + 有 pending task + 显式无 human_pending → deny 催继续
// (回归固化: simple run 跳过 plan_signoff/免签后直接进 IMPLEMENTING, run-state 无
//  human_pending。此时 tick 尚未派发、仍有 pending task, checkImplementingPhase
//  必须落到既有 "pending → deny" 分支催继续 tick 派发, 而非被误当人锚点放行早停。
//  与 8b 的区别: 显式写 human_pending=null, 固化 "免签流程不早停" 这一具体链路。)
// ---------------------------------------------------------------------------

test("simple 免签后 IMPLEMENTING + 有 pending task + 无 human_pending → deny 催继续", async () => {
  const repoRoot = makeRepoRoot("signofffree");
  const planWithPending =
    "schema: loop-engineering.task-plan.v2\n" +
    "complexity: simple\n" +
    "tasks:\n" +
    "  - id: t1\n" +
    "    title: todo task\n" +
    "    allowed_write_paths:\n" +
    "      - src/**\n" +
    "    acceptance_refs:\n" +
    "      - AC1\n" +
    "    status: pending\n";
  makeRun(
    repoRoot,
    "20260101-001",
    {
      run_id: "20260101-001",
      phase: "IMPLEMENTING",
      complexity: "simple",
      trust_mode: "collaborative",
      // 免签: 显式无 human_pending, 证明落到 "有 pending → deny" 分支而非人锚点放行
      human_pending: null,
      active_tasks: [],
    },
    planWithPending,
  );

  const out = await handleGuardAnchors(stopInput(repoRoot));
  expect(out.decision).toBe("deny");
  const reason = (out as { reason?: string }).reason ?? "";
  // reason 应指出还有 pending task 待推进、不该结束回合 (与 8b 断言字样一致)
  expect(reason).toContain("pending");
  expect(reason).toContain("结束回合");
});

// ---------------------------------------------------------------------------
// 用例 9: phase=CREATED / CLARIFYING (无 human_pending) → allow (自动推进)
// ---------------------------------------------------------------------------

test("phase=CREATED 无 human_pending → allow (允许推进)", async () => {
  const repoRoot = makeRepoRoot("created");
  makeRun(repoRoot, "20260101-001", {
    run_id: "20260101-001",
    phase: "CREATED",
    complexity: "simple",
    trust_mode: "collaborative",
    active_tasks: [],
  });

  const out = await handleGuardAnchors(stopInput(repoRoot));
  expect(out.decision).toBe("allow");
});

// ---------------------------------------------------------------------------
// 用例 10: phase=PLANNING (无 human_pending) + 无 plan-check-failures.json → allow
// (软通过: submitPlan 还没跑过或上次通过了, 让 agent 推进到 plan_signoff)
// ---------------------------------------------------------------------------

test("phase=PLANNING 无 human_pending + 无 plan-check-failures.json → allow", async () => {
  const repoRoot = makeRepoRoot("planning");
  makeRun(
    repoRoot,
    "20260101-001",
    {
      run_id: "20260101-001",
      phase: "PLANNING",
      complexity: "simple",
      trust_mode: "collaborative",
      active_tasks: [],
    },
    SINGLE_RUNNING_PLAN,
  );

  const out = await handleGuardAnchors(stopInput(repoRoot));
  // planning/plan-check-failures.json 不存在 → 软通过放行
  expect(out.decision).toBe("allow");
});

// ---------------------------------------------------------------------------
// 用例 10b: phase=PLANNING + plan-check-failures.json 存在且非空 → deny
// (Coordinator.submitPlan 失败后落的结果文件, hook 据此门禁)
// ---------------------------------------------------------------------------

test("phase=PLANNING + plan-check-failures.json 非空 → deny", async () => {
  const repoRoot = makeRepoRoot("planningfail");
  const runDir = makeRun(
    repoRoot,
    "20260101-001",
    {
      run_id: "20260101-001",
      phase: "PLANNING",
      complexity: "simple",
      trust_mode: "collaborative",
      active_tasks: [],
    },
    SINGLE_RUNNING_PLAN,
  );

  // 模拟 Coordinator.submitPlan 失败写下的结果文件
  const planningDir = path.join(runDir, "planning");
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(
    path.join(planningDir, "plan-check-failures.json"),
    JSON.stringify([
      { check: "path_overlap", passed: false, detail: "T1 与 T2 写路径重叠 src/" },
      { check: "acceptance_refs", passed: false, detail: "T3 缺 AC-002" },
    ]),
  );

  const out = await handleGuardAnchors(stopInput(repoRoot));
  expect(out.decision).toBe("deny");
  // reason 应含失败项明细, 便于 agent 定位
  const reason = (out as { reason?: string }).reason ?? "";
  expect(reason).toContain("path_overlap");
  expect(reason).toContain("acceptance_refs");
});

// ---------------------------------------------------------------------------
// 用例 11: phase=WRAPPING_UP (无 human_pending) + 无 check-result.json → allow
// (submitWrapUp 还没跑过 → 软通过, 不锁死)
// ---------------------------------------------------------------------------

test("phase=WRAPPING_UP 无 human_pending + 无 check-result.json → allow", async () => {
  const repoRoot = makeRepoRoot("wrapup");
  makeRun(
    repoRoot,
    "20260101-001",
    {
      run_id: "20260101-001",
      phase: "WRAPPING_UP",
      complexity: "simple",
      trust_mode: "collaborative",
      active_tasks: [],
    },
    SINGLE_RUNNING_PLAN,
  );

  const out = await handleGuardAnchors(stopInput(repoRoot));
  expect(out.decision).toBe("allow");
});

// ---------------------------------------------------------------------------
// 用例 11b: phase=WRAPPING_UP + check-result.json 任一 fail → deny
// ---------------------------------------------------------------------------

test("phase=WRAPPING_UP + check-result.json 含 fail → deny", async () => {
  const repoRoot = makeRepoRoot("wrapupfail");
  const runDir = makeRun(
    repoRoot,
    "20260101-001",
    {
      run_id: "20260101-001",
      phase: "WRAPPING_UP",
      complexity: "simple",
      trust_mode: "collaborative",
      active_tasks: [],
    },
    SINGLE_RUNNING_PLAN,
  );

  const wrapUpDir = path.join(runDir, "wrap-up");
  fs.mkdirSync(wrapUpDir, { recursive: true });
  fs.writeFileSync(
    path.join(wrapUpDir, "check-result.json"),
    JSON.stringify([
      { check: "all_tasks_complete", passed: true, detail: "5/5" },
      { check: "key_diffs_high_risk_filled", passed: false, detail: "T2 缺 key-diffs.yaml" },
    ]),
  );

  const out = await handleGuardAnchors(stopInput(repoRoot));
  expect(out.decision).toBe("deny");
  const reason = (out as { reason?: string }).reason ?? "";
  expect(reason).toContain("key_diffs_high_risk_filled");
});

// ---------------------------------------------------------------------------
// 用例 11c: phase=WRAPPING_UP + check-result.json 全 pass → allow
// ---------------------------------------------------------------------------

test("phase=WRAPPING_UP + check-result.json 全 pass → allow", async () => {
  const repoRoot = makeRepoRoot("wrapuppass");
  const runDir = makeRun(
    repoRoot,
    "20260101-001",
    {
      run_id: "20260101-001",
      phase: "WRAPPING_UP",
      complexity: "simple",
      trust_mode: "collaborative",
      active_tasks: [],
    },
    SINGLE_RUNNING_PLAN,
  );

  const wrapUpDir = path.join(runDir, "wrap-up");
  fs.mkdirSync(wrapUpDir, { recursive: true });
  fs.writeFileSync(
    path.join(wrapUpDir, "check-result.json"),
    JSON.stringify([
      { check: "all_tasks_complete", passed: true, detail: "5/5" },
      { check: "key_diffs_high_risk_filled", passed: true, detail: "T2 ok" },
    ]),
  );

  const out = await handleGuardAnchors(stopInput(repoRoot));
  expect(out.decision).toBe("allow");
});

// ---------------------------------------------------------------------------
// 用例 12: 恶劣输入 (cwd 含 NUL 字节) → 不抛错 (fail-safe 不锁死调用方)
// ---------------------------------------------------------------------------

test("恶劣输入 (cwd 含 NUL 字节) → 不抛错", async () => {
  const NUL = String.fromCharCode(0);
  const badCwd = `bad${NUL}path`;
  delete process.env.LOOP_RUNS_ROOT;

  let threw = false;
  try {
    await handleGuardAnchors(stopInput(badCwd));
  } catch {
    threw = true;
  }
  // 关键: handle 绝不向调用方抛异常 (内部 fail-safe = deny, 但不抛)
  expect(threw).toBe(false);
});
