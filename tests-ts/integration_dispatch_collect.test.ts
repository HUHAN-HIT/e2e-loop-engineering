/**
 * 集成测试: dispatch / collect-outcome CLI 命令端到端 (P5-M7C)。
 *
 * 行为权威: docs/superpowers/specs/...-design.md "方案 3" 验证用例 7-8 (端到端 + OOB)。
 * 被测实现:
 *   - packages/cli/dist/index.js 的 dispatch / collect-outcome 子命令
 *   - packages/ssot-ts/src/runtime/coordinator.ts 的 dispatchReadyTasks / collectTaskOutcome
 *
 * 与 integration_dry_run.test.ts 区别:
 *   - dry-run 用 echo 占位 worker (CLI 进程内同步完成)
 *   - 本测试用真实 CLI bundle, 通过 execFileSync 跨进程驱动
 *   - sub-agent 的工作用直接写文件模拟 (实际场景由 Task 工具触发)
 *
 * 覆盖:
 * 1. 端到端: init → plan → signoff-plan → dispatch → 写 artifact → collect-outcome →
 *    全 complete 自动 submitWrapUp
 * 2. collect-outcome 失败 → reason=task_check_fail + collect-failures.json 落盘
 * 3. bootstrap 降级: 跳过 dispatch, 手动写 task-plan + active_tasks + artifact,
 *    collect-outcome 仍能通过 (actual_writes_source=worker_self_report)
 */
import { test, expect, beforeAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, execFileSync } from "node:child_process";

import { readTaskPlan, writeTaskPlan } from "../packages/ssot-ts/src/runtime/index.js";

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

beforeAll(() => {
  // 确保 cli/dist 是最新产物 (含 dispatch / collect-outcome 子命令)。
  execSync("npm run build", { cwd: REPO_ROOT, stdio: "pipe" });
}, 30000);

/**
 * 把 fixture task-plan.yaml 中的 case id 改写为指定值 (默认 T01-CASE-001)。
 *
 * 原因: collect-outcome 从磁盘读 test-results.yaml, 用例 id 必须与 plan 里 planned case id
 * 一致, 否则 evalTask 判 "未运行" → task_check fail。
 */
function makeTaskPlan(runDir: string, caseId = "T01-CASE-001"): string {
  const src = path.join(REPO_ROOT, "tests-ts", "fixtures", "smoke", "task-plan.yaml");
  const text = fs.readFileSync(src, "utf-8");
  // fixture 用的是 T01-CASE-001, 与默认一致时不需改写
  if (caseId === "T01-CASE-001") {
    return src;
  }
  const dst = path.join(runDir, "planning", "task-plan-custom.yaml");
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, text.replace("T01-CASE-001", caseId), "utf-8");
  return dst;
}

/** 在 runDir 下建一个临时 work 项目的 src/ 子目录 (主代码工作区, 模拟 jeepay 项目)。 */
function makeWorkProject(): string {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "loop-cli-disp-"));
  // 关闭 capabilities 的影响: 把 run 放到独立 tmp, workdir = dirname(runDir) = tmp 父,
  // fs_snapshot 默认开启会扫描到 tasks/T01/* artifact 文件, 误判 OOB。
  // 故 run-state 显式注入 caps={git_diff:false,fs_snapshot:false} 关掉。
  return work;
}

/**
 * 写 tasks/<tid>/test-results.yaml (minimal)。
 *
 * 直接绕过 sub-agent, 模拟 worker 已落 artifact。
 */
function writeArtifacts(
  runDir: string,
  taskId: string,
  opts?: { green?: boolean; caseId?: string; summary?: string },
): void {
  const dir = path.join(runDir, "tasks", taskId);
  fs.mkdirSync(dir, { recursive: true });
  const green = opts?.green ?? true;
  const caseId = opts?.caseId ?? "T01-CASE-001";
  const yaml = `tests_green: ${green}\ncases:\n  - id: ${caseId}\n    passed: ${green}\n    failure_reason: ""\n`;
  fs.writeFileSync(path.join(dir, "test-results.yaml"), yaml, "utf-8");
  fs.writeFileSync(path.join(dir, "summary.md"), opts?.summary ?? "done", "utf-8");
}

// ---------------------------------------------------------------------------
// 1. 端到端: init → plan → signoff-plan → dispatch → 写 artifact → collect → wrap_up
// ---------------------------------------------------------------------------

test("[CLI 端到端] dispatch→collect-outcome 闭环: 单 task 通过 → 自动 submitWrapUp → WRAPPING_UP", () => {
  const work = makeWorkProject();
  try {
    const reqPath = path.join(REPO_ROOT, "tests-ts", "fixtures", "smoke", "req.md");
    const designPath = path.join(REPO_ROOT, "tests-ts", "fixtures", "smoke", "design.md");
    const planPath = makeTaskPlan(work);
    const runsRoot = path.join(work, "runs");

    const run = (...argv: string[]): string =>
      execFileSync(process.execPath, [CLI_BUNDLE, ...argv, "--runs-root", runsRoot], {
        cwd: work,
        encoding: "utf-8",
      });

    // 1. init → CREATED
    const initOut = run("init", reqPath, "--worktree-mode", "none");
    const m = initOut.match(/created run: (\d{8}-\d{3})/);
    expect(m).not.toBeNull();
    const runId = m![1]!;
    const runDir = path.join(runsRoot, runId);

    // 1a. 注入 caps=false 关掉 fs_snapshot 噪音 (run-state.json 已写, 直接覆盖 config 段)
    const statePath = path.join(runDir, "run-state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as Record<string, unknown>;
    state.capabilities = { git_diff: false, fs_snapshot: false };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

    // 2. plan → PLANNING + human_pending=plan_signoff
    run("plan", runId, "--design", designPath, "--task-plan", planPath);

    // 3. signoff-plan → IMPLEMENTING
    run("signoff-plan", runId);

    // 4. dispatch → 输出 packets JSON
    const dispOut = run("dispatch", runId);
    const disp = JSON.parse(dispOut) as {
      run_id: string;
      phase: string;
      packets: Array<{ task_id: string }>;
      all_complete: boolean;
    };
    expect(disp.phase).toBe("IMPLEMENTING");
    expect(disp.packets).toHaveLength(1);
    expect(disp.packets[0]!.task_id).toBe("T01");
    expect(disp.all_complete).toBe(false);

    // 5. 模拟 sub-agent 落 artifact
    writeArtifacts(runDir, "T01", { caseId: "T01-CASE-001" });

    // 6. collect-outcome → verified=true + all_complete=true
    const collOut = run("collect-outcome", runId, "--task", "T01");
    const coll = JSON.parse(collOut) as {
      task_id: string;
      verified: boolean;
      reason: string;
      all_complete: boolean;
      actual_writes_source: string;
    };
    expect(coll.task_id).toBe("T01");
    expect(coll.verified).toBe(true);
    expect(coll.reason).toBe("passed");
    expect(coll.all_complete).toBe(true);

    // 7. 自动 submitWrapUp → WRAPPING_UP
    const statusOut = run("status", runId);
    expect(statusOut).toContain("phase: WRAPPING_UP");
    expect(statusOut).toContain("human_pending: wrap_up_signoff");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. collect-outcome 失败路径
// ---------------------------------------------------------------------------

test("[CLI 端到端] collect-outcome 失败: 写失败的 test-results → reason=task_check_fail + collect-failures.json 落盘", () => {
  const work = makeWorkProject();
  try {
    const reqPath = path.join(REPO_ROOT, "tests-ts", "fixtures", "smoke", "req.md");
    const designPath = path.join(REPO_ROOT, "tests-ts", "fixtures", "smoke", "design.md");
    const planPath = makeTaskPlan(work);
    const runsRoot = path.join(work, "runs");

    const run = (...argv: string[]): string =>
      execFileSync(process.execPath, [CLI_BUNDLE, ...argv, "--runs-root", runsRoot], {
        cwd: work,
        encoding: "utf-8",
      });

    const initOut = run("init", reqPath, "--worktree-mode", "none");
    const runId = initOut.match(/created run: (\d{8}-\d{3})/)![1]!;
    const runDir = path.join(runsRoot, runId);

    // 关 caps
    const statePath = path.join(runDir, "run-state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as Record<string, unknown>;
    state.capabilities = { git_diff: false, fs_snapshot: false };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

    run("plan", runId, "--design", designPath, "--task-plan", planPath);
    run("signoff-plan", runId);
    run("dispatch", runId);

    // 写失败的 test-results
    writeArtifacts(runDir, "T01", { green: false, caseId: "T01-CASE-001" });

    const collOut = run("collect-outcome", runId, "--task", "T01");
    const coll = JSON.parse(collOut) as {
      verified: boolean;
      reason: string;
      max_retries_exceeded: boolean;
    };
    expect(coll.verified).toBe(false);
    expect(coll.reason).toBe("task_check_fail");
    // 默认 max_retries=1, attempt=1 → max_retries_exceeded=true
    expect(coll.max_retries_exceeded).toBe(true);

    // collect-failures.json 落盘
    const cfPath = path.join(runDir, "tasks", "T01", "collect-failures.json");
    expect(fs.existsSync(cfPath)).toBe(true);
    const cf = JSON.parse(fs.readFileSync(cfPath, "utf-8")) as { reason: string };
    expect(cf.reason).toBe("task_check_fail");

    // phase 仍 IMPLEMENTING (没翻 complete, 没回 PLANNING)
    const statusOut = run("status", runId);
    expect(statusOut).toContain("phase: IMPLEMENTING");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. bootstrap 降级 (野生 task: 跳过 dispatch, 直接 collect)
// ---------------------------------------------------------------------------

test("[CLI 端到端] bootstrap 降级: 跳过 dispatch, 手动翻 running + 写 artifact → collect-outcome 通过 (actual_writes_source=worker_self_report)", () => {
  const work = makeWorkProject();
  try {
    const reqPath = path.join(REPO_ROOT, "tests-ts", "fixtures", "smoke", "req.md");
    const designPath = path.join(REPO_ROOT, "tests-ts", "fixtures", "smoke", "design.md");
    const planPath = makeTaskPlan(work);
    const runsRoot = path.join(work, "runs");

    const run = (...argv: string[]): string =>
      execFileSync(process.execPath, [CLI_BUNDLE, ...argv, "--runs-root", runsRoot], {
        cwd: work,
        encoding: "utf-8",
      });

    const initOut = run("init", reqPath, "--worktree-mode", "none");
    const runId = initOut.match(/created run: (\d{8}-\d{3})/)![1]!;
    const runDir = path.join(runsRoot, runId);

    // 关 caps
    const statePath = path.join(runDir, "run-state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as Record<string, unknown>;
    state.capabilities = { git_diff: false, fs_snapshot: false };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

    run("plan", runId, "--design", designPath, "--task-plan", planPath);
    run("signoff-plan", runId);

    // === 不调 dispatch, 直接模拟野生 task (绕过 dispatch.json 落盘) ===
    // 修改 task-plan.yaml: T01 status=running, attempt=1
    // 用 readTaskPlan / writeTaskPlan 走 zod parse → dump, 避免手 sed 产生 duplicate keys
    // (directory.ts 写出的 yaml 已含 status: pending / attempt: 0 默认值)
    const tpPath = path.join(runDir, "planning", "task-plan.yaml");
    const tp = readTaskPlan(tpPath);
    const newTasks = tp.tasks.map((t) =>
      t.id === "T01" ? { ...t, status: "running" as const, attempt: 1 } : t,
    );
    writeTaskPlan(tpPath, { ...tp, tasks: newTasks });

    // 修改 run-state.json: active_tasks=["T01"]
    const state2 = JSON.parse(fs.readFileSync(statePath, "utf-8")) as Record<string, unknown>;
    state2.active_tasks = ["T01"];
    fs.writeFileSync(statePath, JSON.stringify(state2, null, 2), "utf-8");

    // 写 artifact
    writeArtifacts(runDir, "T01", { caseId: "T01-CASE-001" });

    // 确认 dispatch.json 不存在
    expect(fs.existsSync(path.join(runDir, "tasks", "T01", "dispatch.json"))).toBe(false);

    // collect-outcome → bootstrap 降级路径
    const collOut = run("collect-outcome", runId, "--task", "T01");
    const coll = JSON.parse(collOut) as {
      verified: boolean;
      reason: string;
      actual_writes_source: string;
    };
    expect(coll.verified).toBe(true);
    expect(coll.reason).toBe("passed");
    // bootstrap 降级 → worker_self_report (caps 也都 false, 同样 worker_self_report)
    expect(coll.actual_writes_source).toBe("worker_self_report");

    // collect-warnings.txt 落盘 (主 agent 可读)
    expect(
      fs.existsSync(path.join(runDir, "tasks", "T01", "logs", "collect-warnings.txt")),
    ).toBe(true);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. dispatch 输出形状校验 (packets JSON 结构)
// ---------------------------------------------------------------------------

test("[CLI 端到端] dispatch 输出 packets JSON 结构: {run_id, phase, human_pending, packets, all_complete}", () => {
  const work = makeWorkProject();
  try {
    const reqPath = path.join(REPO_ROOT, "tests-ts", "fixtures", "smoke", "req.md");
    const designPath = path.join(REPO_ROOT, "tests-ts", "fixtures", "smoke", "design.md");
    const planPath = makeTaskPlan(work);
    const runsRoot = path.join(work, "runs");

    const run = (...argv: string[]): string =>
      execFileSync(process.execPath, [CLI_BUNDLE, ...argv, "--runs-root", runsRoot], {
        cwd: work,
        encoding: "utf-8",
      });

    const initOut = run("init", reqPath, "--worktree-mode", "none");
    const runId = initOut.match(/created run: (\d{8}-\d{3})/)![1]!;
    const runDir = path.join(runsRoot, runId);

    const statePath = path.join(runDir, "run-state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as Record<string, unknown>;
    state.capabilities = { git_diff: false, fs_snapshot: false };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

    run("plan", runId, "--design", designPath, "--task-plan", planPath);
    run("signoff-plan", runId);

    const dispOut = run("dispatch", runId);
    const disp = JSON.parse(dispOut) as {
      run_id: string;
      phase: string;
      human_pending: string | null;
      packets: Array<{
        task_id: string;
        context_paths: string[];
        allowed_write_paths: string[];
        workdir: string;
      }>;
      all_complete: boolean;
    };
    expect(disp.run_id).toBe(runId);
    expect(disp.phase).toBe("IMPLEMENTING");
    expect(disp.packets).toHaveLength(1);
    expect(disp.packets[0]!.task_id).toBe("T01");
    expect(disp.packets[0]!.context_paths.length).toBeGreaterThan(0);
    expect(disp.packets[0]!.allowed_write_paths).toContain("src/**");
    expect(disp.all_complete).toBe(false);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
