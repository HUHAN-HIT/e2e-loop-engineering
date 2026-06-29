/**
 * e2e-loop 算法 dry-run 子命令 (P5-M7B)。
 *
 * 行为权威: Python `loop_engineering/cli.py` 的 9 个 dry-run 子命令
 * (init / status / plan / run / wrap-up / signoff-plan / signoff-wrap-up / abort / amend)。
 *
 * 这些子命令接 M7A 落的 TS runtime (Coordinator/tick/directory) 与 dispatch
 * (InlineWorkerRunner + echo 占位 worker), 让 TS CLI 达到 Python cli.py 的本地 dry-run 能力:
 * 不打真实 LLM, worker 用 echo 占位 (返回一个最小 completed outcome), 跑通状态机骨架。
 *
 * 与 Python 的对齐要点:
 * - run 根目录默认 <cwd>/runs/, 与 Python `--runs-root` 缺省 ./runs 一致;
 *   本 CLI 用 --runs-root 选项 (缺省 "runs", 相对当前工作目录解析)。
 * - 每个子命令都重建 Coordinator (跨进程恢复): 仅 readRunState 恢复 state, plan 由
 *   Coordinator 构造函数从 planning/task-plan.yaml 一并恢复 (见 coordinator.ts), 否则
 *   run/wrap-up 等后续命令拿到 plan=null 断链。
 * - 错误 → stderr + 返回非 0; 成功 → 简洁 stdout (与现有 install/list 输出风格一致)。
 *
 * 诚实声明: echo 占位 worker 不做真实实现, 仅返回 tests_green=true 的空 case outcome,
 * 用于本地骨架验证 (与 Python `_echo_worker_callback` 等价)。
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  Coordinator,
  buildNavigationMap,
  initRunDir,
  nextRunId,
  readRunState,
  readTaskPlan,
  writeRunState,
  writeTaskPlan,
  type CollectCliResult,
} from "@e2e-loop/ssot/runtime";
import {
  InlineWorkerRunner,
  makeWorkerOutcome,
} from "@e2e-loop/ssot/dispatch";
import type { WorkerOutcome, WorkerPacket } from "@e2e-loop/ssot/dispatch";
import {
  allocateRunWorktree,
  worktreeBindingPath,
  writeWorktreeBinding,
  type WorktreeMode,
} from "@e2e-loop/ssot/worktree";
import { Complexity, Phase, parseRunState } from "@e2e-loop/ssot/schema";
import type { TaskPlan, PlanAmendmentNeeded } from "@e2e-loop/ssot/schema";

import type { Args } from "../args.js";

/**
 * InlineWorkerRunner 占位 callback (等价 Python `_echo_worker_callback`):
 * 返回一个最小 completed outcome (tests_green=true, 空 case 列表)。
 *
 * 真实场景下 callback 应 dispatch 真 LLM/worker; 这里只跑通骨架。
 */
function echoWorkerCallback(packet: WorkerPacket): WorkerOutcome {
  return makeWorkerOutcome({
    status: "completed",
    test_results: { tests_green: true, cases: [] },
    summary_text: `[echo] task ${packet.task_id} done (placeholder worker)`,
  });
}

/** 新建一个绑定 echo 占位 worker 的 InlineWorkerRunner。 */
function makeRunner(): InlineWorkerRunner {
  return new InlineWorkerRunner(echoWorkerCallback);
}

/** 解析 --runs-root (缺省 "runs"), 返回绝对路径。 */
function resolveRunsRoot(args: Args): string {
  const raw = args.values["runs-root"];
  const root = raw && raw.length > 0 ? raw : "runs";
  return path.resolve(root);
}

/** run_id → run_dir。 */
function resolveRunDir(runsRoot: string, runId: string): string {
  return path.join(runsRoot, runId);
}

/** 从位置参数取第 idx 个 (command 已被解析器剥离, positional 从子命令实参起算)。 */
function positional(args: Args, idx: number): string | undefined {
  return args.positional[idx];
}

/** human_pending 的展示文本 (null → "(none)")。 */
function humanPendingText(hp: string | null | undefined): string {
  return hp ?? "(none)";
}

/**
 * 把只读导航图投影渲染成紧凑的多行文本 (供 status 输出)。
 *
 * 只读展示层: 不改任何状态; 证据路径直接透传投影里的相对路径 (正斜杠), 指向事实源文件。
 */
function renderNavigationMap(
  map: ReturnType<typeof buildNavigationMap>,
): string {
  const lines: string[] = [];
  lines.push("navigation_map:");
  for (const p of map.phases) {
    const evidence =
      p.evidence_paths.length > 0 ? ` evidence=${JSON.stringify(p.evidence_paths)}` : "";
    lines.push(`  - ${p.phase}: ${p.status} - ${p.detail}${evidence}`);
  }
  if (map.blocker !== null) {
    lines.push(`blocker: ${map.blocker.kind} - ${map.blocker.reason}`);
    if (map.blocker.evidence_paths.length > 0) {
      lines.push(`blocker_evidence: ${JSON.stringify(map.blocker.evidence_paths)}`);
    }
  } else {
    lines.push("blocker: (none)");
  }
  lines.push(`next_action: ${map.next_action}`);
  return `${lines.join("\n")}\n`;
}

/** 把字符串解析为整数, 失败回退默认值。 */
function parseIntArg(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

function parseWorktreeMode(raw: string | undefined): WorktreeMode | null {
  const mode = raw ?? "none";
  if (mode === "none" || mode === "auto" || mode === "always" || mode === "adopt") {
    return mode;
  }
  return null;
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

/**
 * init 子命令: 建 run + 写 input/requirement.md + run-state.json, 打印 run_id。
 *
 * 用法: e2e-loop init <requirement.md> [--complexity <auto|simple|medium|complex>] [--runs-root <dir>]
 */
export function runInit(args: Args): number {
  const reqFile = positional(args, 0);
  if (!reqFile) {
    process.stderr.write("错误: init 需要位置参数 <requirement.md>\n");
    return 2;
  }
  const reqPath = path.resolve(reqFile);
  if (!fs.existsSync(reqPath)) {
    process.stderr.write("错误: 需求文件不存在: " + reqPath + "\n");
    return 2;
  }
  const requirementText = fs.readFileSync(reqPath, "utf-8");

  const worktreeMode = parseWorktreeMode(args.values["worktree-mode"]);
  if (worktreeMode === null) {
    process.stderr.write("错误: --worktree-mode 必须是 none|auto|always|adopt\n");
    return 2;
  }

  // --complexity auto → simple (与 Python 一致: auto 暂等价 simple)。
  const rawComplexity = args.values.complexity ?? "auto";
  const complexity =
    rawComplexity === "auto"
      ? Complexity.simple
      : (rawComplexity as TaskPlan["complexity"]);

  const sequenceRunsRoot = resolveRunsRoot(args);
  const runId = nextRunId(sequenceRunsRoot);
  const allocation = allocateRunWorktree({
    mode: worktreeMode,
    repoCwd: process.cwd(),
    runId,
    worktreeRoot: args.values["worktree-root"],
    worktreePath: args.values["worktree-path"],
    branchPrefix: args.values["branch-prefix"],
    baseRef: args.values.base,
    requirementSlug: path.basename(reqPath, path.extname(reqPath)),
  });
  const runsRoot = worktreeMode === "none" ? sequenceRunsRoot : allocation.runsRoot;
  const runDir = initRunDir(runsRoot, runId, requirementText);

  const stateInput: Record<string, unknown> = {
    run_id: runId,
    complexity,
    phase: Phase.CREATED,
  };
  if (allocation.binding !== null) {
    const bindingPath = worktreeBindingPath(runDir);
    writeWorktreeBinding(bindingPath, allocation.binding);
    stateInput.workdir = allocation.workdir;
    stateInput.worktree_binding_path = bindingPath;
  }
  const state = parseRunState(stateInput);
  writeRunState(runDir, state);

  process.stdout.write("created run: " + runId + " at " + runDir + "\n");
  process.stdout.write("phase: " + state.phase + ", complexity: " + state.complexity + "\n");
  if (state.workdir) {
    process.stdout.write("workdir: " + state.workdir + "\n");
  }
  return 0;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * status 子命令: 打印 phase / complexity / trust_mode / human_pending / active_tasks。
 *
 * 用法: e2e-loop status <run_id> [--runs-root <dir>]
 */
export function runStatus(args: Args): number {
  const runId = positional(args, 0);
  if (!runId) {
    process.stderr.write("错误: status 需要位置参数 <run_id>\n");
    return 2;
  }
  const runsRoot = resolveRunsRoot(args);
  const runDir = resolveRunDir(runsRoot, runId);
  let state;
  try {
    state = readRunState(runDir);
  } catch {
    process.stderr.write(`错误: run-state.json 不存在: ${runDir}\n`);
    return 2;
  }
  process.stdout.write(`run_id: ${state.run_id}\n`);
  process.stdout.write(`phase: ${state.phase}\n`);
  process.stdout.write(`complexity: ${state.complexity}\n`);
  process.stdout.write(`trust_mode: ${state.trust_mode}\n`);
  process.stdout.write(`human_pending: ${humanPendingText(state.human_pending)}\n`);
  process.stdout.write(`active_tasks: ${JSON.stringify(state.active_tasks)}\n`);
  if (state.aborted_at) {
    process.stdout.write(`aborted_at: ${state.aborted_at}\n`);
    process.stdout.write(`aborted_reason: ${state.aborted_reason}\n`);
  }
  let plan = null;
  const planPath = path.join(runDir, "planning", "task-plan.yaml");
  if (fs.existsSync(planPath)) {
    try {
      plan = readTaskPlan(planPath);
    } catch {
      plan = null;
    }
  }
  process.stdout.write(renderNavigationMap(buildNavigationMap(runDir, state, plan)));
  return 0;
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

/**
 * plan 子命令: 进入 PLANNING, 复制 design + task-plan 到 run_dir, 跑 plan_check,
 * 通过则 set human_pending=plan_signoff。
 *
 * 用法: e2e-loop plan <run_id> --design <file> --task-plan <file> [--runs-root <dir>]
 */
export function runPlan(args: Args): number {
  const runId = positional(args, 0);
  if (!runId) {
    process.stderr.write("错误: plan 需要位置参数 <run_id>\n");
    return 2;
  }
  const designArg = args.values.design;
  const planArg = args.values["task-plan"];
  if (!designArg) {
    process.stderr.write("错误: plan 需要 --design <file>\n");
    return 2;
  }
  if (!planArg) {
    process.stderr.write("错误: plan 需要 --task-plan <file>\n");
    return 2;
  }

  const runsRoot = resolveRunsRoot(args);
  const runDir = resolveRunDir(runsRoot, runId);

  // 复制 design / task-plan 到 run_dir/planning/ (与 Python cmd_plan 一致)。
  const planningDir = path.join(runDir, "planning");
  fs.mkdirSync(planningDir, { recursive: true });
  const designDst = path.join(planningDir, "design.md");
  fs.copyFileSync(path.resolve(designArg), designDst);
  const planDst = path.join(planningDir, "task-plan.yaml");
  fs.copyFileSync(path.resolve(planArg), planDst);

  // 解析 task-plan.yaml → TaskPlan (readTaskPlan 做 load + zod parse)。
  let plan: TaskPlan;
  try {
    plan = readTaskPlan(planDst);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`错误: task-plan.yaml 解析失败: ${msg}\n`);
    return 2;
  }

  const coord = new Coordinator(runDir, makeRunner());
  if (coord.state.phase === Phase.CREATED) {
    coord.startPlanning();
  }
  coord.submitPlan(plan);
  process.stdout.write(
    `run ${runId}: PLANNING 提交完成, phase=${coord.state.phase}, ` +
      `human_pending=${humanPendingText(coord.state.human_pending)}\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

/**
 * run 子命令: IMPLEMENTING tick 循环, 跑到等人或终态。
 *
 * 用法: e2e-loop run <run_id> [--max-ticks <n>] [--runs-root <dir>]
 */
export function runRun(args: Args): number {
  const runId = positional(args, 0);
  if (!runId) {
    process.stderr.write("错误: run 需要位置参数 <run_id>\n");
    return 2;
  }
  const runsRoot = resolveRunsRoot(args);
  const runDir = resolveRunDir(runsRoot, runId);
  const maxTicks = parseIntArg(args.values["max-ticks"], 100);

  const coord = new Coordinator(runDir, makeRunner());
  if (coord.state.phase !== Phase.IMPLEMENTING) {
    process.stderr.write(
      `错误: 当前 phase=${coord.state.phase}, 必须 IMPLEMENTING 才能 run\n`,
    );
    return 2;
  }
  coord.runUntilHumanOrTerminal(maxTicks);
  process.stdout.write(
    `run ${runId}: 循环结束, phase=${coord.state.phase}, ` +
      `human_pending=${humanPendingText(coord.state.human_pending)}\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// wrap-up
// ---------------------------------------------------------------------------

/**
 * wrap-up 子命令: WRAPPING_UP 收口自检。
 *
 * 用法: e2e-loop wrap-up <run_id> [--runs-root <dir>]
 */
export function runWrapUp(args: Args): number {
  const runId = positional(args, 0);
  if (!runId) {
    process.stderr.write("错误: wrap-up 需要位置参数 <run_id>\n");
    return 2;
  }
  const runsRoot = resolveRunsRoot(args);
  const runDir = resolveRunDir(runsRoot, runId);
  const coord = new Coordinator(runDir, makeRunner());
  coord.submitWrapUp();
  process.stdout.write(
    `run ${runId}: wrap-up 完成, phase=${coord.state.phase}, ` +
      `human_pending=${humanPendingText(coord.state.human_pending)}\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// signoff-plan
// ---------------------------------------------------------------------------

/**
 * signoff-plan 子命令 (人盯点 1)。
 *
 * 用法: e2e-loop signoff-plan <run_id> [--reject] [--feedback <text>] [--runs-root <dir>]
 */
export function runSignoffPlan(args: Args): number {
  const runId = positional(args, 0);
  if (!runId) {
    process.stderr.write("错误: signoff-plan 需要位置参数 <run_id>\n");
    return 2;
  }
  const runsRoot = resolveRunsRoot(args);
  const runDir = resolveRunDir(runsRoot, runId);
  const reject = args.flags.has("reject");
  const feedback = args.values.feedback ?? "";
  const coord = new Coordinator(runDir, makeRunner());
  coord.signoffPlan(!reject, feedback);
  process.stdout.write(
    `run ${runId}: plan signoff ${reject ? "rejected" : "accepted"}, ` +
      `phase=${coord.state.phase}\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// signoff-wrap-up
// ---------------------------------------------------------------------------

/**
 * signoff-wrap-up 子命令 (条件收口签收)。
 *
 * 用法: e2e-loop signoff-wrap-up <run_id> [--reject] [--runs-root <dir>]
 */
export function runSignoffWrapUp(args: Args): number {
  const runId = positional(args, 0);
  if (!runId) {
    process.stderr.write("错误: signoff-wrap-up 需要位置参数 <run_id>\n");
    return 2;
  }
  const runsRoot = resolveRunsRoot(args);
  const runDir = resolveRunDir(runsRoot, runId);
  const reject = args.flags.has("reject");
  const coord = new Coordinator(runDir, makeRunner());
  coord.signoffWrapUp(!reject);
  process.stdout.write(
    `run ${runId}: wrap-up signoff ${reject ? "rejected" : "accepted"}, ` +
      `phase=${coord.state.phase}\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// abort
// ---------------------------------------------------------------------------

/**
 * abort 子命令: 任意 phase → ABORTED, 必须给 reason。
 *
 * 用法: e2e-loop abort <run_id> --reason <text> [--runs-root <dir>]
 */
export function runAbort(args: Args): number {
  const runId = positional(args, 0);
  if (!runId) {
    process.stderr.write("错误: abort 需要位置参数 <run_id>\n");
    return 2;
  }
  const reason = args.values.reason;
  if (!reason) {
    process.stderr.write("错误: abort 需要 --reason <text>\n");
    return 2;
  }
  const runsRoot = resolveRunsRoot(args);
  const runDir = resolveRunDir(runsRoot, runId);
  const coord = new Coordinator(runDir, makeRunner());
  coord.abort(reason);
  process.stdout.write(`run ${runId}: ABORTED, reason=${reason}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// amend
// ---------------------------------------------------------------------------

/**
 * amend 子命令: 构造 PlanAmendmentNeeded 调 handlePlanAmendment。
 *
 * 用法: e2e-loop amend <run_id> --reason <text> --ac <AC_ID> [--ac <AC_ID> ...] [--runs-root <dir>]
 *
 * --ac 支持多次出现 (收集为列表, 见 args.ts 的 acList)。
 */
export function runAmend(args: Args): number {
  const runId = positional(args, 0);
  if (!runId) {
    process.stderr.write("错误: amend 需要位置参数 <run_id>\n");
    return 2;
  }
  const reason = args.values.reason;
  if (!reason) {
    process.stderr.write("错误: amend 需要 --reason <text>\n");
    return 2;
  }
  const acRefs = args.acList;
  if (acRefs.length === 0) {
    process.stderr.write("错误: amend 需要至少一个 --ac <AC_ID>\n");
    return 2;
  }
  const runsRoot = resolveRunsRoot(args);
  const runDir = resolveRunDir(runsRoot, runId);
  const coord = new Coordinator(runDir, makeRunner());
  const amendment: PlanAmendmentNeeded = {
    status: "plan-amendment-needed",
    reason,
    touched_acceptance_refs: acRefs,
  };
  coord.handlePlanAmendment(amendment);
  // handlePlanAmendment 只改内存 (与 Python 一致), 这里显式持久化 state + plan
  // (Python cmd_amend 调私有 _refresh_state_file / _refresh_plan_file; TS 私有不可外调,
  //  改用公开的 writeRunState / writeTaskPlan 落盘 coord.state / coord.plan)。
  writeRunState(runDir, coord.state);
  if (coord.plan !== null) {
    writeTaskPlan(path.join(runDir, "planning", "task-plan.yaml"), coord.plan);
  }
  process.stdout.write(
    `run ${runId}: amendment 已应用, phase=${coord.state.phase}\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// dispatch / collect-outcome (P5-M7C 真实 run 命令)
//
// 主 agent 当 coordinator, 推进状态机 + 触发 Task 工具派 implementation-worker。
// 与 dry-run `run` 命令的区别: 不调 echo worker, 不进 tick 循环。
//
// 主流程:
//   1. dispatch <run_id> → 主 agent 拿 packets JSON
//   2. 主 agent 对每个 packet 用 Task 工具触发 implementation-worker 子 agent
//   3. collect-outcome <run_id> --task <id> → 校验 + 推进状态 / 留 running
//   4. 失败 → 主 agent 读 collect-failures.json → 派 fix 子 agent → 再次 dispatch + collect
// ---------------------------------------------------------------------------

/**
 * dispatch 子命令: 推进状态机, 输出 ready packets。
 *
 * 用法: e2e-loop dispatch <run_id> [--runs-root <dir>]
 *
 * stdout (JSON 行):
 *   {"run_id": "...", "phase": "IMPLEMENTING", "packets": [...], "all_complete": false}
 *
 * 主 agent 解析 packets, 对每个 packet 用 Task 工具触发 implementation-worker。
 * packets 为空数组表示无 ready task (全部 complete 或全部 running)。
 */
export function runDispatch(args: Args): number {
  const runId = positional(args, 0);
  if (!runId) {
    process.stderr.write("错误: dispatch 需要位置参数 <run_id>\n");
    return 2;
  }
  const runsRoot = resolveRunsRoot(args);
  const runDir = resolveRunDir(runsRoot, runId);

  const coord = new Coordinator(runDir, makeRunner());
  if (coord.state.phase !== Phase.IMPLEMENTING) {
    process.stderr.write(
      `错误: 当前 phase=${coord.state.phase}, 必须 IMPLEMENTING 才能 dispatch\n`,
    );
    return 2;
  }
  const packets = coord.dispatchReadyTasks();

  const allComplete =
    coord.plan !== null &&
    coord.plan.tasks.length > 0 &&
    coord.plan.tasks.every((t) => t.status === "complete");

  // stdout 一行 JSON (主 agent 易解析; 人类可读也够用)
  const summary = {
    run_id: runId,
    phase: coord.state.phase,
    human_pending: coord.state.human_pending,
    packets,
    all_complete: allComplete,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return 0;
}

/**
 * collect-outcome 子命令: 收回单个 task 的 outcome, 跑校验, 推进状态。
 *
 * 用法: e2e-loop collect-outcome <run_id> --task <id> [--runs-root <dir>]
 *
 * stdout (JSON 行): 完整 CollectCliResult。
 *
 * 主 agent 据 verified / reason / failures / max_retries_exceeded 决定下一步。
 */
export function runCollectOutcome(args: Args): number {
  const runId = positional(args, 0);
  if (!runId) {
    process.stderr.write("错误: collect-outcome 需要位置参数 <run_id>\n");
    return 2;
  }
  const taskId = args.values.task;
  if (!taskId) {
    process.stderr.write("错误: collect-outcome 需要 --task <id>\n");
    return 2;
  }

  const runsRoot = resolveRunsRoot(args);
  const runDir = resolveRunDir(runsRoot, runId);

  const coord = new Coordinator(runDir, makeRunner());
  if (coord.state.phase !== Phase.IMPLEMENTING) {
    process.stderr.write(
      `错误: 当前 phase=${coord.state.phase}, 必须 IMPLEMENTING 才能 collect-outcome\n`,
    );
    return 2;
  }

  const result: CollectCliResult = coord.collectTaskOutcome(taskId);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}
