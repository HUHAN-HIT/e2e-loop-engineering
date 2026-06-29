/**
 * post_task_collect (Hook A / PostToolUse:Task) 等价测试 —— §0.2 防糊弄。
 *
 * 行为权威: Python `loop_engineering/hooks/loop_engineering/post_task_collect.py`
 * 用例源: Python `tests/test_hooks_smoke.py::TestPostTaskCollect` + logic.ts 用例清单
 *
 * TS ↔ Python decision 语义映射 (见 packages/shared/src/types.ts 注释):
 *   - TS decision="defer" (含 context) ↔ Python emit additionalContext (注入 + 放行)
 *   - TS decision="deny"               ↔ Python emit_block (拒绝, block)
 *   - TS decision="allow"              ↔ Python emit_pass_silent (静默放行)
 *
 * 重点覆盖:
 *   - 独立重算 actual_writes 覆盖 worker 自报告 (git diff 真实仓库)
 *   - 必需 artifact 缺失 → deny
 *   - sideEffect 落盘 actual-writes.json 内容
 *
 * 隔离策略: 每个用例用独立 os.tmpdir() repoRoot + 独立 runs/, 通过 LOOP_RUNS_ROOT 定位。
 * 涉及 git diff 通道的用例在 repoRoot 真实 `git init`。
 */

import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as cp from "node:child_process";
import { handlePostTaskCollect, type HookInput } from "@e2e-loop/shared";

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-ptc-${label}-`));
  _toClean.push(root);
  return root;
}

/** 建 runs/<runId>/, 写 run-state.json + (可选) task-plan.yaml, 设 LOOP_RUNS_ROOT。返回 runDir。 */
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
  fs.mkdirSync(path.join(runDir, "clarification"), { recursive: true });
  fs.mkdirSync(path.join(runDir, "wrap-up"), { recursive: true });
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

/** 单 task t1 (status=running), allowed_write_paths=src/**。 */
const IMPL_PLAN =
  "schema: loop-engineering.task-plan.v2\n" +
  "complexity: simple\n" +
  "tasks:\n" +
  "  - id: t1\n" +
  "    title: impl task\n" +
  "    allowed_write_paths:\n" +
  "      - src/**\n" +
  "    acceptance_refs:\n" +
  "      - AC1\n" +
  "    status: running\n";

/** 写 implementation-worker 的三必需 artifact。 */
function writeImplArtifacts(
  runDir: string,
  taskId: string,
  opts: { green?: boolean; summary?: string; keyDiffs?: string } = {},
): void {
  const dir = path.join(runDir, "tasks", taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "test-results.yaml"),
    `tests_green: ${opts.green ?? true}\n`,
    "utf-8",
  );
  fs.writeFileSync(
    path.join(dir, "summary.md"),
    opts.summary ?? "# 任务摘要\n实现完成。\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(dir, "key-diffs.yaml"),
    opts.keyDiffs ?? "diffs: []\n",
    "utf-8",
  );
}

/** PostToolUse:Task 的 HookInput。 */
function taskInput(
  cwd: string,
  subagentType: string,
  toolResponse: unknown = { result: "ok" },
): HookInput {
  return {
    event: "PostToolUse",
    toolName: "Task",
    toolInput: { subagent_type: subagentType, prompt: "..." },
    toolResponse,
    cwd,
  };
}

/** 在 repoRoot 初始化一个真实 git 仓库 (用于 git diff 通道)。 */
function gitInit(repoRoot: string): void {
  const opts = { cwd: repoRoot, stdio: "ignore" as const };
  cp.execFileSync("git", ["init"], opts);
  cp.execFileSync("git", ["config", "user.email", "test@example.com"], opts);
  cp.execFileSync("git", ["config", "user.name", "test"], opts);
  cp.execFileSync("git", ["commit", "--allow-empty", "-m", "init"], opts);
}

const baseState = (runId: string) => ({
  run_id: runId,
  phase: "IMPLEMENTING",
  complexity: "simple",
  trust_mode: "collaborative",
  active_tasks: ["t1"],
});

// ---------------------------------------------------------------------------
// 用例 1: implementation-worker + 三 artifact 齐全 + tests_green=true
//   → defer; context.tests_green_mechanical=true; sideEffect 落 actual-writes.json
// ---------------------------------------------------------------------------

test("impl + 三 artifact 齐全 + tests_green=true → defer, tests_green_mechanical=true, 有 sideEffect", async () => {
  const repoRoot = makeRepoRoot("implok");
  const runDir = makeRun(repoRoot, "20260101-001", baseState("20260101-001"), IMPL_PLAN);
  writeImplArtifacts(runDir, "t1", { green: true });

  const out = await handlePostTaskCollect(taskInput(repoRoot, "implementation-worker"));

  expect(out.decision).toBe("defer");
  const ctx = out.context!;
  expect(ctx.verified).toBe(true);
  expect(ctx.worker).toBe("implementation-worker");
  expect(ctx.task_id).toBe("t1");
  expect(ctx.tests_green_mechanical).toBe(true);
  // sideEffect: actual-writes.json 落盘, content 含 {source, is_authoritative, writes}
  expect(out.sideEffect).toBeDefined();
  expect(out.sideEffect!.file).toBe(
    path.join(runDir, "tasks", "t1", "actual-writes.json"),
  );
  const content = out.sideEffect!.content as {
    source: string;
    is_authoritative: boolean;
    writes: string[];
  };
  expect(content).toHaveProperty("source");
  expect(content).toHaveProperty("is_authoritative");
  expect(Array.isArray(content.writes)).toBe(true);
});

// ---------------------------------------------------------------------------
// 用例 2: implementation-worker + 缺 summary.md → deny; reason 含 "artifact"
// ---------------------------------------------------------------------------

test("impl + 缺 summary.md → deny, reason 含 artifact", async () => {
  const repoRoot = makeRepoRoot("implmiss");
  const runDir = makeRun(repoRoot, "20260101-001", baseState("20260101-001"), IMPL_PLAN);
  // 只写 test-results.yaml 与 key-diffs.yaml, 故意漏 summary.md
  const dir = path.join(runDir, "tasks", "t1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "test-results.yaml"), "tests_green: true\n", "utf-8");
  fs.writeFileSync(path.join(dir, "key-diffs.yaml"), "diffs: []\n", "utf-8");

  const out = await handlePostTaskCollect(taskInput(repoRoot, "implementation-worker"));

  expect(out.decision).toBe("deny");
  expect(out.reason ?? "").toContain("artifact");
  // 缺失文件名应出现在 reason 中
  expect(out.reason ?? "").toContain("summary.md");
});

// ---------------------------------------------------------------------------
// 用例 3: implementation-worker + tests_green=false → defer (不 block);
//   context.tests_green_mechanical=false (由 coordinator 决定是否重跑)
// ---------------------------------------------------------------------------

test("impl + tests_green=false → defer (不 block), tests_green_mechanical=false", async () => {
  const repoRoot = makeRepoRoot("implred");
  const runDir = makeRun(repoRoot, "20260101-001", baseState("20260101-001"), IMPL_PLAN);
  writeImplArtifacts(runDir, "t1", { green: false });

  const out = await handlePostTaskCollect(taskInput(repoRoot, "implementation-worker"));

  // 关键: tests_green=false 不 block (与 guard_anchors 不同), 只机械如实上报
  expect(out.decision).toBe("defer");
  expect(out.context!.tests_green_mechanical).toBe(false);
});

// ---------------------------------------------------------------------------
// 用例 4: implementation-worker + 找不到 status=running 的 task → deny
// ---------------------------------------------------------------------------

test("impl + 无 running task → deny (无法定位 artifacts)", async () => {
  const repoRoot = makeRepoRoot("implnotask");
  const planAllComplete =
    "schema: loop-engineering.task-plan.v2\n" +
    "complexity: simple\n" +
    "tasks:\n" +
    "  - id: t1\n" +
    "    title: done\n" +
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

  const out = await handlePostTaskCollect(taskInput(repoRoot, "implementation-worker"));
  expect(out.decision).toBe("deny");
  expect(out.reason ?? "").toContain("running");
});

// ---------------------------------------------------------------------------
// 用例 5: 独立重算 actual_writes 覆盖 worker 自报告 (真实 git 仓库 + 越界声明)
//
// worker 自报告声称写了 src/real.ts (确实改动, git 抓到) 与 fake/ghost.ts (实际未落盘);
// git diff 只会抓到 src/real.ts → actual_writes.source="git", is_authoritative=true,
// 且 warnings 标红 "fake/ghost.ts 自报但 git 未抓到" (§0.2 防糊弄)。
// ---------------------------------------------------------------------------

test("独立重算 actual_writes (git 通道) 覆盖自报告; 自报未落盘路径进 warnings", async () => {
  const repoRoot = makeRepoRoot("gitrecalc");
  gitInit(repoRoot);
  // 真实改动一个文件并 git add (staged), 让 git status --porcelain 列出完整路径
  // src/real.ts 而非折叠目录 src/ —— 这与 Python collect_via_git_diff 行为完全一致
  // (未追踪目录会被 git 折叠为目录名, 故须 add 进索引才得到文件级路径)。
  fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "src", "real.ts"), "export const x = 1;\n", "utf-8");
  cp.execFileSync("git", ["add", "src/real.ts"], { cwd: repoRoot, stdio: "ignore" });

  const runDir = makeRun(repoRoot, "20260101-001", baseState("20260101-001"), IMPL_PLAN);
  writeImplArtifacts(runDir, "t1", { green: true });

  // worker 自报告里提到两个路径: 一个真实(src/real.ts) 一个虚构(fake/ghost.ts)
  const toolResponse = {
    result: "我修改了 src/real.ts 和 fake/ghost.ts 两个文件。",
  };
  const out = await handlePostTaskCollect(
    taskInput(repoRoot, "implementation-worker", toolResponse),
  );

  expect(out.decision).toBe("defer");
  const aw = out.context!.actual_writes as {
    source: string;
    is_authoritative: boolean;
    writes: string[];
  };
  // git 通道生效 → authoritative
  expect(aw.source).toBe("git");
  expect(aw.is_authoritative).toBe(true);
  // git 抓到真实改动 src/real.ts
  expect(aw.writes).toContain("src/real.ts");
  // git 未抓到虚构 fake/ghost.ts → 不在 writes 里 (独立重算覆盖了自报告)
  expect(aw.writes).not.toContain("fake/ghost.ts");
  // §0.2 防糊弄 warning: 自报但 git 未抓到
  const warnings = out.context!.warnings as string[];
  expect(warnings.some((w) => w.includes("fake/ghost.ts"))).toBe(true);
  // sideEffect 落盘内容与 context.actual_writes 一致
  const content = out.sideEffect!.content as { writes: string[]; source: string };
  expect(content.source).toBe("git");
  expect(content.writes).toContain("src/real.ts");
});

// ---------------------------------------------------------------------------
// 用例 6: 非 git 目录 → actual_writes 降级 self_report (非 authoritative) + warning
// ---------------------------------------------------------------------------

test("非 git 目录 → actual_writes 降级 self_report, 非 authoritative + warning", async () => {
  const repoRoot = makeRepoRoot("nogit");
  // 不 git init → tryGitDiff 返回 null; 无 before/after.snapshot → fs 也 null → self_report
  const runDir = makeRun(repoRoot, "20260101-001", baseState("20260101-001"), IMPL_PLAN);
  writeImplArtifacts(runDir, "t1", {
    green: true,
    // self_report 从 summary.md / key-diffs.yaml 文本抓路径
    summary: "改动了 src/foo.ts\n",
  });

  const out = await handlePostTaskCollect(taskInput(repoRoot, "implementation-worker"));

  expect(out.decision).toBe("defer");
  const aw = out.context!.actual_writes as { source: string; is_authoritative: boolean };
  expect(aw.source).toBe("self_report");
  expect(aw.is_authoritative).toBe(false);
  const warnings = out.context!.warnings as string[];
  // self_report 来源应触发 "数据不可信" warning
  expect(warnings.some((w) => w.includes("self_report"))).toBe(true);
});

// ---------------------------------------------------------------------------
// 用例 7: plan-agent + design.md + task-plan.yaml 齐全 → defer; verified=true
// ---------------------------------------------------------------------------

test("plan-agent + design.md + task-plan.yaml 齐全 → defer, verified=true", async () => {
  const repoRoot = makeRepoRoot("planok");
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
    IMPL_PLAN,
  );
  fs.writeFileSync(path.join(runDir, "planning", "design.md"), "# 设计\n", "utf-8");

  const out = await handlePostTaskCollect(taskInput(repoRoot, "plan-agent"));

  expect(out.decision).toBe("defer");
  expect(out.context!.verified).toBe(true);
  expect(out.context!.worker).toBe("plan-agent");
  // 诚实标注 (SKILL §2 信条 5): hook 不跑 plan_check, 由 Coordinator.submitPlan 跑;
  // 不能注入 plan_check_all_pass=true 误导主 agent。
  expect(out.context!.plan_check_ran_by).toBe("coordinator");
  expect(out.context!.plan_check_failures_path).toBe(
    "planning/plan-check-failures.json",
  );
  expect(out.context!.plan_check_all_pass).toBeUndefined();
});

// ---------------------------------------------------------------------------
// 用例 8: plan-agent + 缺 design.md → deny; reason 含 artifact
// ---------------------------------------------------------------------------

test("plan-agent + 缺 design.md → deny, reason 含 artifact", async () => {
  const repoRoot = makeRepoRoot("planmiss");
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
    IMPL_PLAN,
  );
  // 不写 design.md (task-plan.yaml 已由 makeRun 写)

  const out = await handlePostTaskCollect(taskInput(repoRoot, "plan-agent"));
  expect(out.decision).toBe("deny");
  expect(out.reason ?? "").toContain("artifact");
  expect(out.reason ?? "").toContain("design.md");
});

// ---------------------------------------------------------------------------
// 用例 9: clarification-finder + questions.json 含 3 问题 → defer; question_count=3
// ---------------------------------------------------------------------------

test("clarification-finder + questions.json 含 3 问题 → defer, question_count=3", async () => {
  const repoRoot = makeRepoRoot("clarok");
  const runDir = makeRun(repoRoot, "20260101-001", {
    run_id: "20260101-001",
    phase: "CLARIFYING",
    complexity: "simple",
    trust_mode: "collaborative",
    active_tasks: [],
  });
  fs.writeFileSync(
    path.join(runDir, "clarification", "questions.json"),
    JSON.stringify({
      questions: [
        { id: "q1", text: "a?" },
        { id: "q2", text: "b?" },
        { id: "q3", text: "c?" },
      ],
    }),
    "utf-8",
  );

  const out = await handlePostTaskCollect(taskInput(repoRoot, "clarification-finder"));

  expect(out.decision).toBe("defer");
  expect(out.context!.verified).toBe(true);
  expect(out.context!.question_count).toBe(3);
});

// ---------------------------------------------------------------------------
// 用例 10: clarification-finder + 空 questions 且空 skip_basis → deny; reason 含 skip_basis
// (用户决策 2026-06-28: "无需澄清" 不能无证落盘)
// ---------------------------------------------------------------------------

test("clarification-finder + 空 questions 且空 skip_basis → deny, reason 含 skip_basis", async () => {
  const repoRoot = makeRepoRoot("clarempty");
  const runDir = makeRun(repoRoot, "20260101-001", {
    run_id: "20260101-001",
    phase: "CLARIFYING",
    complexity: "simple",
    trust_mode: "collaborative",
    active_tasks: [],
  });
  fs.writeFileSync(
    path.join(runDir, "clarification", "questions.json"),
    JSON.stringify({ questions: [] }),
    "utf-8",
  );

  const out = await handlePostTaskCollect(taskInput(repoRoot, "clarification-finder"));
  expect(out.decision).toBe("deny");
  expect(out.reason ?? "").toContain("skip_basis");
});

// ---------------------------------------------------------------------------
// 用例 10b: clarification-finder + 空 questions 但非空 skip_basis → defer (裁量跳过留证合法)
// ---------------------------------------------------------------------------

test("clarification-finder + 空 questions 但非空 skip_basis → defer, skip_basis_count=2", async () => {
  const repoRoot = makeRepoRoot("clarskip");
  const runDir = makeRun(repoRoot, "20260101-001", {
    run_id: "20260101-001",
    phase: "CLARIFYING",
    complexity: "medium",
    trust_mode: "collaborative",
    active_tasks: [],
  });
  fs.writeFileSync(
    path.join(runDir, "clarification", "questions.json"),
    JSON.stringify({
      questions: [],
      skip_basis: [
        { considered: "过期时间", why_non_blocking: "默认 5 分钟" },
        { considered: "大小写", why_non_blocking: "默认不敏感" },
      ],
    }),
    "utf-8",
  );

  const out = await handlePostTaskCollect(taskInput(repoRoot, "clarification-finder"));
  expect(out.decision).toBe("defer");
  expect(out.context!.verified).toBe(true);
  expect(out.context!.skip_basis_count).toBe(2);
  expect(out.context!.question_count).toBe(0);
});

// ---------------------------------------------------------------------------
// 用例 11: clarification-finder + questions.json 缺失 → deny; reason 含 artifact
// (Python test_clarification_missing_artifact_blocks)
// ---------------------------------------------------------------------------

test("clarification-finder + questions.json 缺失 → deny, reason 含 artifact 或 questions", async () => {
  const repoRoot = makeRepoRoot("clarmiss");
  makeRun(repoRoot, "20260101-001", {
    run_id: "20260101-001",
    phase: "CLARIFYING",
    complexity: "simple",
    trust_mode: "collaborative",
    active_tasks: [],
  });
  // 不写 questions.json

  const out = await handlePostTaskCollect(taskInput(repoRoot, "clarification-finder"));
  expect(out.decision).toBe("deny");
  const reason = (out.reason ?? "").toLowerCase();
  expect(reason.includes("artifact") || reason.includes("questions")).toBe(true);
});

// ---------------------------------------------------------------------------
// 用例 12: red-team-reviewer + red-team-review.md 齐全 → defer; verified=true
// ---------------------------------------------------------------------------

test("red-team-reviewer + red-team-review.md 齐全 → defer, verified=true", async () => {
  const repoRoot = makeRepoRoot("redteam");
  const runDir = makeRun(repoRoot, "20260101-001", {
    run_id: "20260101-001",
    phase: "WRAPPING_UP",
    complexity: "simple",
    trust_mode: "collaborative",
    active_tasks: [],
  });
  fs.writeFileSync(
    path.join(runDir, "wrap-up", "red-team-review.md"),
    "# 红队复审\n无致命问题。\n",
    "utf-8",
  );

  const out = await handlePostTaskCollect(taskInput(repoRoot, "red-team-reviewer"));
  expect(out.decision).toBe("defer");
  expect(out.context!.verified).toBe(true);
  expect(out.context!.worker).toBe("red-team-reviewer");
});

// ---------------------------------------------------------------------------
// 用例 13: 非 loop-engineering worker → allow (静默放行)
// (Python test_non_loop_worker_passes_silent)
// ---------------------------------------------------------------------------

test("非 loop-engineering worker (other-agent) → allow 静默放行", async () => {
  const repoRoot = makeRepoRoot("nonloop");
  makeRun(repoRoot, "20260101-001", baseState("20260101-001"), IMPL_PLAN);

  const out = await handlePostTaskCollect(taskInput(repoRoot, "some-other-agent"));
  expect(out.decision).toBe("allow");
  // 静默放行: 无 reason 无 context
  expect(out.reason).toBeUndefined();
  expect(out.context).toBeUndefined();
});

// ---------------------------------------------------------------------------
// 用例 14: 无活跃 run + loop worker 交回 → deny; reason 含 init_run_dir
// ---------------------------------------------------------------------------

test("无活跃 run + loop worker 交回 → deny, reason 含 init_run_dir", async () => {
  const repoRoot = makeRepoRoot("norun");
  const runsRoot = path.join(repoRoot, "runs");
  fs.mkdirSync(runsRoot, { recursive: true });
  process.env.LOOP_RUNS_ROOT = runsRoot;

  const out = await handlePostTaskCollect(taskInput(repoRoot, "implementation-worker"));
  expect(out.decision).toBe("deny");
  expect(out.reason ?? "").toContain("init_run_dir");
});
