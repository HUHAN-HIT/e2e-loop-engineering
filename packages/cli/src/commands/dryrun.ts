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
 * - run 根目录默认取决于 worktree mode; auto 会落到隔离 worktree 的 runs/, 与 Python `--runs-root` 缺省 ./runs 一致;
 *   本 CLI 用 --runs-root 选项 (缺省 "runs", 相对当前工作目录解析)。
 * - 每个子命令都重建 Coordinator (跨进程恢复): 仅 readRunState 恢复 state, plan 由
 *   Coordinator 构造函数从 planning/task-plan.yaml 一并恢复 (见 coordinator.ts), 否则
 *   run/wrap-up 等后续命令拿到 plan=null 断链。
 * - 错误 → stderr + 返回非 0; 成功 → 简洁 stdout (与现有 install/list 输出风格一致)。
 *
 * 诚实声明: echo 占位 worker 不做真实实现, 仅返回 tests_green=true 的空 case outcome,
 * 用于本地骨架验证 (与 Python `_echo_worker_callback` 等价)。
 */

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  Coordinator,
  buildNavigationMap,
  initRunDir,
  nextRunIdFromRoots,
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
  resolveWorktreeRoot,
  worktreeBindingPath,
  writeWorktreeBinding,
  type WorktreeMode,
} from "@e2e-loop/ssot/worktree";
import { Complexity, Phase, parseRunState } from "@e2e-loop/ssot/schema";
import type { TaskPlan, PlanAmendmentNeeded } from "@e2e-loop/ssot/schema";
import { isInLoopWorktree, readWorktreeMarker } from "@e2e-loop/shared";

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

/**
 * 列出所有 git worktree(主仓 + linked, 含 EnterWorktree 的 .claude/worktrees/* 与 loop 的
 * .worktrees/*)的 runs/ 目录, 作为 run_id 序号源。
 *
 * 动机: EnterWorktree 化后每个 run 落在各自 worktree 的 runs/, 若 none 模式序号只扫当前
 * worktree 的 runs/(彼此独立、都空), 会让不同 worktree 都从 YYYYMMDD-001 起 → 跨 worktree
 * 撞号。用 git worktree list 把所有 worktree 的 runs/ 一并纳入序号源, 序号才能全局前进。
 * 非 git 目录 / git 失败 → 返回 [], 序号退回只扫当前 cwd/runs(现有 none 行为, 不回归)。
 */
export function allWorktreeRunsRoots(cwd: string): string[] {
  try {
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd,
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out
      .split(/\r?\n/)
      .filter((l) => l.startsWith("worktree "))
      .map((l) => path.join(l.slice("worktree ".length).trim(), "runs"));
  } catch {
    return [];
  }
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
  const mode = raw ?? "auto";
  if (mode === "none" || mode === "auto" || mode === "always" || mode === "adopt") {
    return mode;
  }
  return null;
}

// ---------------------------------------------------------------------------
// resume: worktree bootstrap 后自动弹终端续跑 (供 init 兜底脚本 + resume 命令共用)
// ---------------------------------------------------------------------------

/**
 * 弹出的新会话首条消息: 触发 loop-engineering skill。
 * SKILL 检测 active_run 非空 + 已在 worktree 内 → 走"续跑"分支 (coordinator.md §5 阶段 0)。
 */
const RESUME_PROMPT = "/loop-engineering";

/** 弹终端命令的注入点 (测试注入 fake 记录调用, 不真弹窗)。 */
export type TerminalSpawner = (cmd: string, args: readonly string[]) => void;

/** 默认 spawner: detached + unref, 让新终端窗口独立于父进程存活。 */
function defaultTerminalSpawner(cmd: string, args: readonly string[]): void {
  const child = spawn(cmd, [...args], { detached: true, stdio: "ignore" });
  child.unref();
}

/** POSIX 单引号包裹 (内部单引号转义), 供 darwin/linux 弹终端命令拼路径。 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * 按平台构造"弹新终端 + cd 到 worktree + 起 claude 续跑会话"的命令。
 * 返回 null = 该平台无已知弹终端手段 → 调用方降级为手动引导。
 *
 * 纯函数 (只依赖 platform + workdir), 便于单测各平台分支; 真正 spawn 由 TerminalSpawner 注入。
 */
export function buildResumeSpawn(
  platform: NodeJS.Platform,
  workdir: string,
): { cmd: string; args: string[] } | null {
  if (platform === "win32") {
    // start "" (空标题占位, 防带引号路径被当窗口标题) → 新 cmd 窗口; /k 保持窗口; cd /d 跨盘符。
    return {
      cmd: "cmd.exe",
      args: ["/c", "start", "", "cmd", "/k", `cd /d "${workdir}" && claude "${RESUME_PROMPT}"`],
    };
  }
  if (platform === "darwin") {
    const inner = `cd ${shellQuote(workdir)} && claude ${RESUME_PROMPT}`;
    return {
      cmd: "osascript",
      args: ["-e", `tell application "Terminal" to do script "${inner}"`],
    };
  }
  if (platform === "linux") {
    // best-effort: x-terminal-emulator 不存在时由 spawner 抛错 → 调用方降级。
    return {
      cmd: "x-terminal-emulator",
      args: ["-e", `sh -c "cd ${shellQuote(workdir)} && claude ${RESUME_PROMPT}"`],
    };
  }
  return null;
}

/**
 * 在 worktree 根写一键续跑脚本 (resume.cmd / resume.sh), 作为自动弹终端失败时的手动兜底入口。
 * 双击/运行即 cd 到脚本所在目录 (worktree 根) 并起 claude 续跑会话。
 */
function writeResumeScripts(workdir: string, runId: string): void {
  const cmd =
    "@echo off\r\n" +
    `REM Loop Engineering: 进入本 worktree 续跑 run ${runId} (宿主命令非 claude 请改末行)\r\n` +
    'cd /d "%~dp0"\r\n' +
    `claude "${RESUME_PROMPT}"\r\n`;
  fs.writeFileSync(path.join(workdir, "resume.cmd"), cmd, "utf-8");

  const sh =
    "#!/usr/bin/env sh\n" +
    `# Loop Engineering: 进入本 worktree 续跑 run ${runId} (宿主命令非 claude 请改末行)\n` +
    'cd "$(dirname "$0")" || exit 1\n' +
    `claude "${RESUME_PROMPT}"\n`;
  const shPath = path.join(workdir, "resume.sh");
  fs.writeFileSync(shPath, sh, "utf-8");
  try {
    fs.chmodSync(shPath, 0o755);
  } catch {
    /* Windows / 权限受限: 忽略 (脚本仍可 sh resume.sh 运行) */
  }
}

/**
 * worktree 模式硬 gate (spec: 2026-06-29-worktree-only-isolation-design 改动②)。
 *
 * 只对 "worktree 模式" 的 run 生效 —— 判据严格区分 none vs worktree:
 *   - 读 run-state, 取 state.workdir。读不到 state (缺失/解析失败) → 不 gate, 放行
 *     (让下游命令体的 Coordinator 构造去报缺失; gate 不抢错)。
 *   - state.workdir 为空/null (即 worktree-mode=none 的 run) → 不 gate, 放行
 *     (现有 dry-run/dispatch 测试绝大多数是 none 模式, 必须保持放行)。
 *   - state.workdir 非空 (worktree 模式) → 要求当前 cwd 就在该 run 的 worktree:
 *     readWorktreeMarker(cwd) 非空且 marker.run_id === 该 run 的 run_id。
 *     不满足 → 写 stderr + 返回 2 (拒绝); 满足 → 返回 null (放行)。
 *
 * 返回 number → 命令应以此退出码拒绝; 返回 null → 放行 (继续命令体)。
 */
function worktreeGate(runDir: string, runId: string, command: string): number | null {
  let workdir: string | null | undefined;
  try {
    // 用 shared 的 readRunState (返回 null 不抛); 这里直接读 run-state.json 取 workdir。
    const statePath = path.join(runDir, "run-state.json");
    const raw = JSON.parse(fs.readFileSync(statePath, "utf-8")) as Record<string, unknown>;
    const w = raw.workdir;
    workdir = typeof w === "string" ? w : null;
  } catch {
    // 读不到 state → 不 gate (放行, 让命令体的 Coordinator 去报错)
    return null;
  }

  // none 模式 (workdir 空/null) → 不 gate
  if (!workdir) return null;

  // worktree 模式 → 要求 cwd 在该 worktree (marker.run_id 匹配)
  const marker = readWorktreeMarker(process.cwd());
  if (marker !== null && marker.run_id === runId) {
    return null; // cwd 就在该 run 的 worktree, 放行
  }
  process.stderr.write(
    `错误: run ${runId} 是 worktree 模式, 请在其 worktree 内运行 ${command} ` +
      `(cd ${workdir})\n`,
  );
  return 2;
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

  // 改动③ (一个 worktree 一个 run): 若 cwd 已身处一个 loop worktree → 拒绝再 init 新 run。
  // 必须在 allocateRunWorktree 之前 (此前不触碰 git), 让 "一 worktree 一 run" 铁律机械成立。
  if (isInLoopWorktree(process.cwd())) {
    process.stderr.write(
      "错误: 一个 worktree 只跑一个 run; 当前已身处一个 loop worktree。" +
        "请回主工程根 bootstrap 新 run (e2e-loop init <req> --worktree-mode always)。\n",
    );
    return 2;
  }

  const sequenceRunsRoot = resolveRunsRoot(args);
  // worktree 模式下 run 目录写进 <worktree>/runs, 主仓 ./runs 永远空; 只扫它取序号会永远撞 ...-001
  // (即便上一个 run 成功也撞, 因 .worktrees/<run_id> 仍在)。故把 worktree 根一并纳入序号源:
  // 其下 created worktree 目录名即 run_id, 序号才能随已有 run 前进。none 模式仍只扫主仓 ./runs。
  const seqRoots =
    worktreeMode === "none"
      ? [sequenceRunsRoot, ...allWorktreeRunsRoots(process.cwd())]
      : [sequenceRunsRoot, resolveWorktreeRoot(process.cwd(), args.values["worktree-root"])];
  const runId = nextRunIdFromRoots(seqRoots);
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
  // --require-plan-signoff (opt-out 开关): 写 config.require_plan_signoff=true, 让干净 simple
  // plan 回到人工 plan 门禁 (默认免签); 不给该 flag 时保持 schema 默认 (false → 自动接受)。
  if (args.flags.has("require-plan-signoff")) {
    stateInput.config = { require_plan_signoff: true };
  }
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

  // 改动② (bootstrap 引导): worktree 模式 (allocation.binding!=null) 时, 在 worktree 根写
  // 一键续跑脚本 (自动弹终端失败时的手动兜底), 并打印引导:
  // coordinator 会自动跑 `e2e-loop resume <run_id>` 弹终端在 worktree 内续跑到 plan 签署,
  // 人零操作; 未弹出 (无已知终端 / spawn 失败) 时双击脚本手动进入。
  if (allocation.binding !== null) {
    writeResumeScripts(allocation.workdir, runId);
    process.stdout.write(
      "\n下一步 (loop hook 只在该 worktree 内会话生效):\n" +
        `    coordinator 将自动跑  e2e-loop resume ${runId}  弹终端在 worktree 内续跑到 plan 签署。\n` +
        "    若未自动弹出, 双击 worktree 根的 resume.cmd (Windows) 或运行 sh resume.sh (macOS/Linux):\n" +
        `        cd ${allocation.workdir}\n` +
        "    并行开多个 run 时, 在主工程根跑  e2e-loop runs  可总览各支线停在哪 (含 plan 签署)。\n" +
        "    (在主工程根直接跑 dispatch/run 会被 CLI 拒绝并引导回 worktree。)\n",
    );
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
  // 免签检测: submitPlan 对干净 simple plan 免签直进 IMPLEMENTING 时会写 plan-auto-accepted.json
  // (诚实审计标记), stdout 追加说明; 措辞用 "auto-accepted"/"免签", 绝不称 "签署"。
  const autoAccepted = fs.existsSync(
    path.join(runDir, "planning", "plan-auto-accepted.json"),
  );
  process.stdout.write(
    `run ${runId}: PLANNING 提交完成, phase=${coord.state.phase}, ` +
      `human_pending=${humanPendingText(coord.state.human_pending)}` +
      (autoAccepted ? " (auto-accepted: simple 免签, 无人工签署)" : "") +
      `\n`,
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

  // 改动② (worktree 硬 gate): worktree 模式的 run 必须在其 worktree 内推进; none 模式放行。
  const gate = worktreeGate(runDir, runId, "run");
  if (gate !== null) return gate;

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

  // 改动② (worktree 硬 gate): worktree 模式的 run 必须在其 worktree 内推进; none 模式放行。
  const gate = worktreeGate(runDir, runId, "dispatch");
  if (gate !== null) return gate;

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

// ---------------------------------------------------------------------------
// resume (自动弹终端续跑)
// ---------------------------------------------------------------------------

/**
 * 定位一个 run 的目录: 先主根 runs/<id> (none 模式), 再扫各 worktree 下的 runs/<id> (worktree 模式)。
 *
 * resume 从主工程根跑 (coordinator bootstrap 后就地调), 而 worktree 模式 run 的 run 目录在
 * .worktrees/<worktree>/runs/<id> —— 不能只看主根 runs/ (否则 worktree run 永远定位不到)。
 * 返回 null = 两处都没有该 run 的 run-state.json。
 */
function locateRunDir(args: Args, runId: string): string | null {
  const mainDir = resolveRunDir(resolveRunsRoot(args), runId);
  if (fs.existsSync(path.join(mainDir, "run-state.json"))) return mainDir;
  try {
    const wtRoot = resolveWorktreeRoot(process.cwd(), args.values["worktree-root"]);
    for (const e of fs.readdirSync(wtRoot, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const d = path.join(wtRoot, e.name, "runs", runId);
      if (fs.existsSync(path.join(d, "run-state.json"))) return d;
    }
  } catch {
    /* 非 git / .worktrees 不存在 → 仅主根结果 (此处已 null) */
  }
  return null;
}

/**
 * resume 子命令: worktree 模式 run 的自动续跑入口。
 *
 * 读 run-state 拿 workdir, 弹一个新终端在该 worktree 里起 claude 会话续跑 (首条消息
 * /loop-engineering → skill 检测 active_run 走"已在 worktree 内→续跑"分支, 推进到 plan 签署)。
 *
 * 用法: e2e-loop resume <run_id> [--runs-root <dir>]
 *
 * fail-safe: 无已知弹终端手段 / spawn 抛错 → 打印手动引导 (worktree 根 resume 脚本), 退出 0,
 * 绝不锁死。none 模式 run (无 workdir) → 提示就地续跑, 退出 0。
 *
 * spawner 参数注入 (测试注入 fake 记录调用, 不真弹窗)。
 */
export function runResume(
  args: Args,
  spawner: TerminalSpawner = defaultTerminalSpawner,
): number {
  const runId = positional(args, 0);
  if (!runId) {
    process.stderr.write("错误: resume 需要位置参数 <run_id>\n");
    return 2;
  }
  const runDir = locateRunDir(args, runId);
  if (runDir === null) {
    process.stderr.write(
      `错误: 找不到 run ${runId} 的 run-state.json (主根 runs/ 与 .worktrees 下均无)\n`,
    );
    return 2;
  }
  const state = readRunState(runDir);
  const workdir = state.workdir;
  if (!workdir) {
    process.stdout.write(
      `run ${runId} 是 none 模式 (无隔离 worktree), 无需弹终端; 本会话就地续跑即可。\n`,
    );
    return 0;
  }

  const fallback = (): number => {
    process.stdout.write(
      "\n未能自动弹出终端, 请手动进入 worktree 续跑:\n" +
        `    双击 ${path.join(workdir, "resume.cmd")} (Windows)\n` +
        `    或运行 sh ${path.join(workdir, "resume.sh")} (macOS/Linux)\n` +
        `    或手动 cd ${workdir} 后启动 claude 会话\n`,
    );
    return 0;
  };

  const spec = buildResumeSpawn(process.platform, workdir);
  if (spec === null) return fallback();
  try {
    spawner(spec.cmd, spec.args);
  } catch {
    return fallback();
  }
  process.stdout.write(
    `已为 run ${runId} 弹出新终端在 worktree 续跑 (${workdir}); 该窗口会自动推进到 plan 签署。\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// runs (并行 run 总览)
// ---------------------------------------------------------------------------

interface RunOverviewRow {
  run_id: string;
  phase: string;
  complexity: string;
  human_pending: string | null;
  workdir: string | null;
  /** run 的实际物理目录 (无论 none/worktree 都是真实位置; EnterWorktree 化后 none run 也在 worktree)。 */
  dir: string;
}

/** 扫一个 runs 根下所有 <run_id>/run-state.json, 收集概览行 (非 run 目录 / 坏 state 跳过)。 */
function collectRunsUnder(runsRoot: string, rows: RunOverviewRow[]): void {
  let entries;
  try {
    entries = fs.readdirSync(runsRoot, { withFileTypes: true });
  } catch {
    return; // runs 根不存在 → 无 run
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const runDir = path.join(runsRoot, e.name);
    let state;
    try {
      state = readRunState(runDir);
    } catch {
      continue;
    }
    rows.push({
      run_id: state.run_id,
      phase: state.phase,
      complexity: state.complexity,
      human_pending: state.human_pending ?? null,
      workdir: state.workdir ?? null,
      dir: runDir,
    });
  }
}

/**
 * runs 子命令: 并行 run 总览。扫主根 runs/ (none 模式) 与 .worktrees 下各 worktree 的 runs/
 * (worktree 模式), 打印每个 run 的 phase / human_pending / complexity / workdir。并行开发多 run
 * 时, 一眼看全哪条支线停在 plan 签署 (human_pending)。
 *
 * 用法: e2e-loop runs [--runs-root <dir>] [--worktree-root <dir>] [--json]
 */
export function runRuns(args: Args): number {
  // 收集所有 runs 根: 主根(--runs-root) + 所有 git worktree 的 runs/。allWorktreeRunsRoots
  // 经 git worktree list 覆盖 EnterWorktree 的 .claude/worktrees/* 与 loop 自建的 .worktrees/*
  // (与 run_id 防撞用的是同一份来源, 保持总览与序号一致); 非 git 目录降级为仅主根。
  const collected: RunOverviewRow[] = [];
  const roots = new Set<string>([resolveRunsRoot(args)]);
  for (const r of allWorktreeRunsRoots(process.cwd())) roots.add(r);
  for (const root of roots) collectRunsUnder(root, collected);

  // 去重: 同一物理 run 目录可能被多个源重复收集(如 --runs-root 恰是主仓 runs, 又被 git
  // worktree list 列为主仓)。按实际目录去重(Windows 大小写不敏感)。
  const seen = new Set<string>();
  const rows = collected.filter((r) => {
    const key = process.platform === "win32" ? r.dir.toLowerCase() : r.dir;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  rows.sort((a, b) => a.run_id.localeCompare(b.run_id));

  if (args.flags.has("json")) {
    process.stdout.write(`${JSON.stringify({ runs: rows }, null, 2)}\n`);
    return 0;
  }
  if (rows.length === 0) {
    process.stdout.write("没有 run (主根 runs/ 与各 worktree 的 runs/ 均为空)。\n");
    return 0;
  }
  process.stdout.write(`共 ${rows.length} 个 run:\n`);
  for (const r of rows) {
    process.stdout.write(
      `  ${r.run_id}  phase=${r.phase}  human_pending=${humanPendingText(r.human_pending)}` +
        `  complexity=${r.complexity}  dir=${r.dir}\n`,
    );
  }
  return 0;
}
