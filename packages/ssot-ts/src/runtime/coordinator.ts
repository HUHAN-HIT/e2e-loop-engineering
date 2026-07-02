/**
 * Loop Engineering 编排器 (design §1 主流程 + §6 单写者 + §3.7 tick 顺序)。
 *
 * 行为权威: Python `loop_engineering/runtime/coordinator.py`。
 *
 * Coordinator 是唯一写 run-state.json / task-plan.yaml 的角色 (§prompts §A)。
 * 持有 state + plan + 外部 map (startedAt / staleCount / capabilities / snapshots),
 * 推进状态机, 与人沟通。
 *
 * 诚实声明: tick 内的"立即翻 running + 同步 dispatch" 是 MVP 简化 (真实场景 runner.dispatch
 * 应是非阻塞异步, 这里用阻塞调用, 测试用 RecordingWorkerRunner 驱动)。
 *
 * 跨进程恢复 (§关键坑点): CLI 每个子命令都重建 Coordinator, 仅 readRunState 恢复 state。
 * plan 必须从 planning/task-plan.yaml 一并恢复, 否则 run/wrap-up 等后续命令拿到 plan=null →
 * runTick 报 "plan 为空" (端到端断链)。见 tests-ts/ssot/coordinator_plan_restore.test.ts。
 */
import * as fs from "node:fs";
import * as path from "node:path";

import * as yaml from "js-yaml";

import { applyRollback, computeRollback, summarize } from "../amendment/rollback.js";
import { checkPlan } from "../checklists/plan_check.js";
import { checkWrapUp } from "../checklists/wrap_up_check.js";
import type { TaskCheckItem, TaskCheckResult } from "../checklists/task_check.js";
import { pathGlobsOverlap } from "../scheduling/path_overlap.js";
import { readyFrontier } from "../scheduling/ready_frontier.js";
import { probeCapabilities } from "../scheduling/capabilities.js";
import { isMeaningful } from "../schema/artifacts.js";
import {
  KeyDiffsFileSchema,
  TestResultsSchema,
} from "../schema/artifacts.js";
import type {
  KeyDiffsFile,
  PlanAmendmentNeeded,
  TestResults,
} from "../schema/artifacts.js";
import { parseClarificationQuestions } from "../schema/clarification.js";
import type {
  ClarificationAnswers,
  ClarificationQuestions,
} from "../schema/clarification.js";
import { HumanPending, Phase } from "../schema/run_state.js";
import type { RunCapabilities, RunState } from "../schema/run_state.js";
import { parseServiceContracts } from "../schema/service_contracts.js";
import type { ServiceContracts } from "../schema/service_contracts.js";
import { RiskLevel, TaskStatus } from "../schema/task_plan.js";
import type { TaskPlan } from "../schema/task_plan.js";
import type { TaskDetail } from "../schema/task_detail.js";
import {
  clearHumanPending,
  isAwaitingHuman,
  setHumanPending,
} from "../state_machine/human_anchors.js";
import { advancePhase, isTerminal } from "../state_machine/transitions.js";
import { shouldAutoAcceptPlan } from "../state_machine/plan_auto_accept.js";
import { buildPacket } from "../dispatch/packet.js";
import type { WorkerPacket } from "../dispatch/packet.js";
import {
  collectOutcome,
  takeFsSnapshot,
  takeGitBaseRef,
} from "../dispatch/collect.js";
import type { CollectedTaskResult, FsSnapshot } from "../dispatch/collect.js";
import { makeWorkerOutcome } from "../dispatch/worker_runner.js";
import type { WorkerOutcome, WorkerRunner } from "../dispatch/worker_runner.js";
import {
  actualWritesPath,
  dispatchMetaPath,
  initTaskDir,
  readActualWrites,
  readDispatchMeta,
  readRunState,
  readTaskPlan,
  readTaskDetail,
  writeActualWrites,
  writeCollectFailures,
  writeDispatchMeta,
  writeRunState,
  writeTaskPlan,
  type ActualWritesFile,
  type CollectFailures,
  type DispatchMeta,
} from "./directory.js";
import { tick } from "./tick.js";
import { readWorktreeBindingOrNull, worktreeBindingPath } from "../worktree/binding.js";
import type { TickResult, TickRuntime } from "./tick.js";
import { dumpKeyDiffsYaml } from "./yaml_io.js";

// ---------------------------------------------------------------------------
// CollectCliResult: `collect-outcome` 命令的返回形状 (stdout JSON)
// ---------------------------------------------------------------------------

/**
 * `loop-eng collect-outcome` 命令的 stdout 输出形状。
 *
 * 主 agent 据 verified / reason / failures / max_retries_exceeded 决定下一步:
 * - verified=true → 跑 dispatch 拿下一批 (advanced_to 给出下一个 ready task_id 提示)
 * - reason=plan_amendment → 跑 `loop-eng amend` 处理 (不派 fix 子 agent)
 * - reason=task_check_fail / failed / oob → 派 fix 子 agent (prompt 带 failures + oob_paths)
 * - max_retries_exceeded=true → 主 agent 决定 abort 或人接
 *
 * actual_writes_source 让主 agent 判断 collect 可信度:
 * - "git_diff" / "fs_snapshot" → 可信 (authoritative)
 * - "worker_self_report" → 不可信 (bootstrap 降级 / capabilities 缺失)
 */
export interface CollectCliResult {
  readonly task_id: string;
  /** 自检全过且无越界 = true。 */
  readonly verified: boolean;
  /**
   * 失败原因分类:
   * - "passed": 通过
   * - "task_check_fail": 任务自检未通过 (测试/AC/路径)
   * - "failed": outcome.status=failed (worker 自报失败或 artifact 全缺)
   * - "oob": actual_writes 越界 (优先级高于 task_check_fail)
   * - "plan_amendment": 触发 plan 修正 (已自动 handlePlanAmendment, 主 agent 走 amend)
   * - "not_running": task 不是 running 状态 (未 dispatch 或已 complete)
   * - "not_found": task 在 plan 里找不到
   */
  readonly reason: string;
  readonly task_check_all_pass: boolean;
  /** 全部自检项 (含通过的); 主 agent 可全量回看。 */
  readonly failures: TaskCheckItem[];
  /** 越界路径列表 (reason=oob 时非空)。 */
  readonly oob_paths: string[];
  /** "git_diff" | "fs_snapshot" | "worker_self_report" */
  readonly actual_writes_source: string;
  /** 下一个 ready task_id (无则 ""); 提示主 agent 下一步可派谁。 */
  readonly advanced_to: string;
  /** 全部 task 是否都已 complete (自动 submitWrapUp 触发标志)。 */
  readonly all_complete: boolean;
  /** 当前重试次数 (dispatch 时递增; collect 失败不递增)。 */
  readonly attempt: number;
  readonly max_retries_per_task: number;
  /** attempt ≥ max_retries_per_task 且本次未通过 → true (主 agent 决策权)。 */
  readonly max_retries_exceeded: boolean;
}

/** UTC 当前时间。 */
function nowUtc(): Date {
  return new Date();
}

/**
 * Loop Engineering 编排器。持有 run-state + plan, 推进状态机, 与人沟通。单写者。
 *
 * 有状态类: 持有 state + plan + 外部 map。每次 submit_* 方法跑对应 checklist, 不通过 →
 * 同一 phase 内修一次, 失败升级给人。signoff_* 方法 clear human_pending + advancePhase。
 */
export class Coordinator {
  readonly runDir: string;
  readonly workdir: string;
  private readonly runner: WorkerRunner;
  state: RunState;
  plan: TaskPlan | null = null;
  capabilities: RunCapabilities;

  // tick 的外部可变运行时 map。
  readonly startedAtByTask = new Map<string, Date>();
  readonly staleCountByTask = new Map<string, number>();
  readonly beforeSnapshots = new Map<string, FsSnapshot>();
  readonly earlierTaskWrites = new Map<string, string[]>();
  readonly baseRefs = new Map<string, string>();

  // 收口阶段缓存的每 task 任务自检结果 + key-diffs。
  private readonly taskCheckResults = new Map<string, TaskCheckResult>();
  private readonly keyDiffsByTask = new Map<string, KeyDiffsFile | null>();

  constructor(runDir: string, runner: WorkerRunner) {
    this.runDir = runDir;
    this.runner = runner;
    this.state = readRunState(runDir);
    const binding = readWorktreeBindingOrNull(runDir);
    this.workdir = this.state.workdir ?? binding?.worktree_path ?? path.dirname(runDir);
    if (binding !== null && (this.state.workdir === null || this.state.workdir === undefined)) {
      this.state = {
        ...this.state,
        workdir: this.workdir,
        worktree_binding_path: this.state.worktree_binding_path ?? worktreeBindingPath(runDir),
      };
    }

    // capabilities 探测 (§3.4 CREATED 时一次性写入 run-state, 此后固定):
    // 反序列化已有 → 沿用; 缺失 → probe 后挂到 state, 由下一次 refreshStateFile 顺带写回
    // (不在构造时立即写, 避免 Windows 文件锁 race + 减少 IO)。
    if (this.state.capabilities === null || this.state.capabilities === undefined) {
      this.capabilities = probeCapabilities(this.workdir);
      this.state = { ...this.state, capabilities: this.capabilities };
    } else {
      this.capabilities = this.state.capabilities;
    }

    // 跨进程恢复: plan 必须从 planning/task-plan.yaml 一并恢复, 否则后续命令断链。
    const planPath = path.join(runDir, "planning", "task-plan.yaml");
    if (fs.existsSync(planPath)) {
      this.plan = readTaskPlan(planPath);
    }
  }

  // ------------------------------------------------------------------
  // 持久化 helpers
  // ------------------------------------------------------------------
  /** 把 state 写回 run-state.json (单写者, 原子写)。 */
  private refreshStateFile(): void {
    writeRunState(this.runDir, this.state);
  }

  /** 把 plan 写回 planning/task-plan.yaml (若 plan 已就绪)。 */
  private refreshPlanFile(): void {
    if (this.plan === null) return;
    const planPath = path.join(this.runDir, "planning", "task-plan.yaml");
    writeTaskPlan(planPath, this.plan);
  }

  /** 构造 tick 用的 runtime map 包装 (引用同一组 Map)。 */
  private tickRuntime(): TickRuntime {
    return {
      startedAtByTask: this.startedAtByTask,
      staleCountByTask: this.staleCountByTask,
      beforeSnapshots: this.beforeSnapshots,
      earlierTaskWrites: this.earlierTaskWrites,
      baseRefs: this.baseRefs,
    };
  }

  // ------------------------------------------------------------------
  // phase 推进
  // ------------------------------------------------------------------
  /** CREATED → PLANNING (简化: 直接跳过可选的 CLARIFYING, design §1)。 */
  startClarifying(): void {
    if (this.state.phase === Phase.CREATED) {
      this.state = advancePhase(this.state, Phase.PLANNING);
      this.refreshStateFile();
    }
  }

  /**
   * 存 questions.json (含 skip_basis)。
   *
   * 方法论演进 (2026-06-28): 澄清不再单独停人——无论有无阻塞问题, 都不 set 人盯点;
   * 有阻塞问题时带 default_if_unanswered 继续, 问题在 plan 签署时一并呈现。
   */
  submitClarification(q: ClarificationQuestions): void {
    const qPath = path.join(this.runDir, "clarification", "questions.json");
    fs.mkdirSync(path.dirname(qPath), { recursive: true });
    fs.writeFileSync(qPath, `${JSON.stringify(q, null, 2)}\n`, "utf-8");
  }

  /**
   * 存 answers.json → 进 PLANNING (CLARIFYING 时)。
   *
   * 方法论演进 (2026-06-28): 无 clarification 锚点可清; 仅记录默认采纳并推进。
   */
  answerClarification(answers: ClarificationAnswers): void {
    const aPath = path.join(this.runDir, "clarification", "answers.json");
    fs.mkdirSync(path.dirname(aPath), { recursive: true });
    fs.writeFileSync(aPath, `${JSON.stringify(answers, null, 2)}\n`, "utf-8");
    if (this.state.phase === Phase.CLARIFYING) {
      this.state = advancePhase(this.state, Phase.PLANNING);
    }
    this.refreshStateFile();
  }

  /** 读取 clarification/questions.json (供 plan 自检的澄清证据兜底); 不存在返回 null。 */
  private readClarificationQuestions(): ClarificationQuestions | null {
    const p = path.join(this.runDir, "clarification", "questions.json");
    if (!fs.existsSync(p)) return null;
    try {
      return parseClarificationQuestions(JSON.parse(fs.readFileSync(p, "utf-8")));
    } catch {
      // 解析失败按"无有效证据"处理 → plan_check 据此判 fail (而非静默放行)。
      return null;
    }
  }


  /** 读取当前 plan 声明的 task detail 文件; 解析失败记为 null, 交由 plan_check 产出诊断。 */
  private readTaskDetails(plan: TaskPlan): Record<string, TaskDetail | null> {
    const details: Record<string, TaskDetail | null> = {};
    for (const task of plan.tasks) {
      const ref = task.detail_ref ?? null;
      if (ref === null) continue;
      try {
        details[ref.replace(/\\/g, "/")] = readTaskDetail(path.join(this.runDir, ref));
      } catch {
        details[ref.replace(/\\/g, "/")] = null;
      }
    }
    return details;
  }
  /** → PLANNING (从 CREATED 或 CLARIFYING 进)。 */
  startPlanning(): void {
    if (this.state.phase === Phase.CREATED || this.state.phase === Phase.CLARIFYING) {
      this.state = advancePhase(this.state, Phase.PLANNING);
      this.refreshStateFile();
    }
  }

  /**
   * plan agent 提交: 跑 plan_check。
   *
   * 通过后: simple 且未触发风险闸(risk:high / exclusive / 契约)、未强制 require_plan_signoff
   *   → 免签自动 advance 到 IMPLEMENTING 并写 plan-auto-accepted.json; 否则 set human_pending=plan_signoff。
   * 不通过 → 写 plan + plan-check-failures.json, 保留 PLANNING (让 agent 重交), 不 advance。
   */
  submitPlan(plan: TaskPlan): void {
    if (this.state.phase !== Phase.PLANNING) {
      throw new Error(`submitPlan 必须在 PLANNING phase (当前 ${this.state.phase})`);
    }
    this.plan = plan;
    // 跑计划自检. 多服务契约文件存在时纳入 gate; 澄清证据兜底 (medium/complex 跳过须留证)。
    const contracts = this.readServiceContracts();
    const clarification = this.readClarificationQuestions();
    const taskDetails = this.readTaskDetails(plan);
    const result = checkPlan(plan, {
      contracts,
      pathOverlapFn: pathGlobsOverlap,
      clarification,
      taskDetails,
    });
    if (!result.all_pass) {
      this.refreshPlanFile();
      const failPath = path.join(this.runDir, "planning", "plan-check-failures.json");
      const failures = result.items
        .filter((i) => !i.passed)
        .map((i) => ({ check: i.check, passed: i.passed, detail: i.detail }));
      fs.mkdirSync(path.dirname(failPath), { recursive: true });
      fs.writeFileSync(failPath, `${JSON.stringify(failures, null, 2)}`, "utf-8");
      // 不 set human_pending (让 agent 重交); 不 advance。
      return;
    }
    // 通过 → 写 plan。simple 且未触发风险闸/未强制门禁 → 免签自动进 IMPLEMENTING; 否则设 plan_signoff。
    this.refreshPlanFile();
    const hasContracts = fs.existsSync(
      path.join(this.runDir, "planning", "service-contracts.yaml"),
    );
    const autoAccept = shouldAutoAcceptPlan({
      complexity: this.state.complexity,
      tasks: plan.tasks,
      requirePlanSignoff: this.state.config.require_plan_signoff,
      hasServiceContracts: hasContracts,
    });
    if (autoAccept) {
      // 诚实记账: 免签 ≠ 已签, 写独立审计标记后直接 advance (不设 human_pending)。
      this.writePlanAutoAccepted(plan, hasContracts);
      this.state = advancePhase(this.state, Phase.IMPLEMENTING);
    } else {
      this.state = setHumanPending(this.state, HumanPending.plan_signoff);
    }
    this.refreshStateFile();
  }

  /**
   * 免签时写诚实审计标记 planning/plan-auto-accepted.json。
   *
   * 与 signoff-feedback.md (人工反馈) 分属不同文件/语义, 绝不复用; 措辞禁用"签署/signed"。
   * 后续任何人翻此 run, 一眼看出"计划从未经人工冻结意图, 是规则自动放行的"。
   */
  private writePlanAutoAccepted(plan: TaskPlan, hasContracts: boolean): void {
    const hasHigh = plan.tasks.some((t) => t.risk === RiskLevel.high);
    const hasExclusive = plan.tasks.some((t) => t.exclusive);
    const marker = {
      auto_accepted: true,
      accepted_at: nowUtc().toISOString(),
      reason:
        "complexity=simple 且未触发风险闸(无 risk:high / 无 exclusive / 无 service-contracts)",
      criteria_snapshot: {
        complexity: this.state.complexity,
        require_plan_signoff: this.state.config.require_plan_signoff,
        has_high_risk: hasHigh,
        has_exclusive: hasExclusive,
        has_contracts: hasContracts,
      },
    };
    const p = path.join(this.runDir, "planning", "plan-auto-accepted.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${JSON.stringify(marker, null, 2)}\n`, "utf-8");
  }

  /** 读取 planning/service-contracts.yaml; 不存在表示单服务 run (返回 null)。 */
  private readServiceContracts(): ServiceContracts | null {
    const p = path.join(this.runDir, "planning", "service-contracts.yaml");
    if (!fs.existsSync(p)) return null;
    const data = yaml.load(fs.readFileSync(p, "utf-8"));
    return parseServiceContracts(data);
  }

  /** 多服务或契约 run 收口必须提供集成结果。 */
  private requiresIntegrationResults(): boolean {
    if (this.plan === null) return false;
    if (fs.existsSync(path.join(this.runDir, "planning", "service-contracts.yaml"))) {
      return true;
    }
    return this.plan.tasks.some(
      (t) =>
        (t.service !== null && t.service !== undefined && t.service !== "") ||
        t.provides_contracts.length > 0 ||
        t.consumes_contracts.length > 0,
    );
  }

  /** 读 wrap-up/integration-results.json (人/CI 手动填); 不存在/非法 → null。 */
  private readIntegrationResults(): Record<string, boolean> | null {
    const p = path.join(this.runDir, "wrap-up", "integration-results.json");
    if (!fs.existsSync(p)) return null;
    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      return null;
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      out[String(k)] = Boolean(v);
    }
    return out;
  }

  /** 人盯点 1. accepted=true → clear anchor + → IMPLEMENTING; false → 留 PLANNING。 */
  signoffPlan(accepted: boolean, feedback = ""): void {
    if (this.state.phase !== Phase.PLANNING) {
      throw new Error(`signoffPlan 必须在 PLANNING phase (当前 ${this.state.phase})`);
    }
    if (accepted) {
      this.state = clearHumanPending(this.state);
      this.state = advancePhase(this.state, Phase.IMPLEMENTING);
      this.refreshStateFile();
    } else {
      // 拒绝: 留 PLANNING, feedback 写到 planning/signoff-feedback.md。
      const fbPath = path.join(this.runDir, "planning", "signoff-feedback.md");
      fs.mkdirSync(path.dirname(fbPath), { recursive: true });
      fs.writeFileSync(fbPath, feedback, "utf-8");
      this.refreshStateFile();
    }
  }

  /** → IMPLEMENTING (调用方应改用 runUntilHumanOrTerminal)。 */
  startImplementing(): void {
    if (this.state.phase === Phase.PLANNING && this.plan !== null) {
      this.state = advancePhase(this.state, Phase.IMPLEMENTING);
      this.refreshStateFile();
    }
  }

  /** → WRAPPING_UP, 跑收口自检; 普通全绿自动 COMPLETE, 异常/高风险才停人。 */
  submitWrapUp(): void {
    if (this.state.phase !== Phase.IMPLEMENTING) {
      throw new Error(
        `submitWrapUp 必须在 IMPLEMENTING phase (当前 ${this.state.phase})`,
      );
    }
    if (this.plan === null) {
      throw new Error("submitWrapUp 时 plan 为空");
    }
    this.state = advancePhase(this.state, Phase.WRAPPING_UP);

    // 收口自检的 scope: planned = 全 task allowed_write_paths 展平; actual = earlierTaskWrites 累积。
    const plannedScope = [
      ...new Set(this.plan.tasks.flatMap((t) => t.allowed_write_paths)),
    ].sort();
    const actualScope = [
      ...new Set([...this.earlierTaskWrites.values()].flat()),
    ].sort();
    const integrationResults = this.readIntegrationResults();

    const result = checkWrapUp(
      this.plan,
      this.taskCheckResults,
      this.keyDiffsByTask,
      {
        integrationResults,
        plannedScopeFiles: plannedScope,
        actualScopeFiles: actualScope,
        requiresIntegration: this.requiresIntegrationResults(),
      },
    );

    // 写结果到 wrap-up/check-result.json。
    const checkPath = path.join(this.runDir, "wrap-up", "check-result.json");
    fs.mkdirSync(path.dirname(checkPath), { recursive: true });
    const items = result.items.map((i) => ({
      check: i.check,
      passed: i.passed,
      detail: i.detail,
    }));
    fs.writeFileSync(checkPath, `${JSON.stringify(items, null, 2)}`, "utf-8");

    const hasManualWrapUpTask = this.plan.tasks.some(
      (t) => t.risk === RiskLevel.high || t.exclusive,
    );
    if (!result.all_pass || hasManualWrapUpTask) {
      // 失败时必须停人, 否则 tick 会空转; 高风险/独占任务也保留收口锚点供红队材料与人验收。
      this.state = setHumanPending(this.state, HumanPending.wrap_up_signoff);
      this.refreshStateFile();
      return;
    }

    this.state = advancePhase(this.state, Phase.COMPLETE);
    this.refreshStateFile();
  }
  /**
   * 条件收口签收. accepted=true → COMPLETE; false → 回 IMPLEMENTING。
   *
   * §A4 修复: accepted=true 时强制读 wrap-up/check-result.json 校验全 pass; 未通过拒绝签收。
   */
  signoffWrapUp(accepted: boolean): void {
    if (this.state.phase !== Phase.WRAPPING_UP) {
      throw new Error(
        `signoffWrapUp 必须在 WRAPPING_UP phase (当前 ${this.state.phase})`,
      );
    }
    if (accepted) {
      const checkPath = path.join(this.runDir, "wrap-up", "check-result.json");
      if (fs.existsSync(checkPath)) {
        let items: Array<{ passed?: boolean }> = [];
        try {
          const parsed: unknown = JSON.parse(fs.readFileSync(checkPath, "utf-8"));
          if (Array.isArray(parsed)) items = parsed as Array<{ passed?: boolean }>;
        } catch {
          items = [];
        }
        const failed = items.filter((i) => !i.passed);
        if (failed.length > 0) {
          throw new Error(
            `signoffWrapUp(accepted=true) 拒绝: 收口自检未通过 (${failed.length} 项失败, ` +
              "见 wrap-up/check-result.json)。请先 signoffWrapUp(false) 回 IMPLEMENTING 修。",
          );
        }
      }
      this.state = clearHumanPending(this.state);
      this.state = advancePhase(this.state, Phase.COMPLETE);
      this.refreshStateFile();
    } else {
      // 拒绝: 回 IMPLEMENTING 就近返工 (design §1)。
      this.state = clearHumanPending(this.state);
      this.state = advancePhase(this.state, Phase.IMPLEMENTING);
      this.refreshStateFile();
    }
  }

  /** 任意 phase → ABORTED. 必须给 reason。 */
  abort(reason: string): void {
    this.state = advancePhase(this.state, Phase.ABORTED, reason);
    this.refreshStateFile();
  }

  // ------------------------------------------------------------------
  // 真实 run (非 dryrun): dispatch / collect-outcome
  //
  // 这两个方法不调 runner, 不进 tick 循环。主 agent (Claude Code 主上下文) 当协调器:
  // 1. dispatch → 标 ready task running + 落 dispatch.json + 返回 packets
  // 2. 主 agent 对每个 packet 用 Task 工具触发 implementation-worker 子 agent
  // 3. collect-outcome → 读 dispatch.json + 磁盘 artifact, 校验, 推进状态 / 留 running
  //
  // 跨进程持久化: dispatch.json (派发元数据) / collect-failures.json (失败详情) /
  // actual-writes.json (跨 task 越界检测重建用)。
  // ------------------------------------------------------------------

  /**
   * 推进状态机: 选 ready task, 标 running, 落 dispatch.json, 返回 packets。
   *
   * 调用方 (主 agent) 拿 packets JSON, 用 Task 工具触发 implementation-worker。
   *
   * @throws Error phase≠IMPLEMENTING 或 plan 为空
   * @returns WorkerPacket[] (可能多个, 主 agent 决定并发; 简单档一般只一个)
   */
  dispatchReadyTasks(): WorkerPacket[] {
    if (this.state.phase !== Phase.IMPLEMENTING) {
      throw new Error(
        `dispatchReadyTasks 必须在 IMPLEMENTING phase (当前 ${this.state.phase})`,
      );
    }
    if (this.plan === null) {
      throw new Error("dispatchReadyTasks 时 plan 为空");
    }

    const activeTaskObjs = this.plan.tasks.filter((t) =>
      this.state.active_tasks.includes(t.id),
    );
    const ready = readyFrontier(this.plan.tasks, activeTaskObjs);
    if (ready.length === 0) return [];

    const designMd = path.join(this.runDir, "planning", "design.md");
    const taskPlanYaml = path.join(this.runDir, "planning", "task-plan.yaml");
    // 占位 design.md (与 runTick 一致, 测试用)
    if (!fs.existsSync(designMd)) {
      fs.mkdirSync(path.dirname(designMd), { recursive: true });
      fs.writeFileSync(designMd, "# Design (placeholder)\n", "utf-8");
    }

    const packets: WorkerPacket[] = [];
    const newTasks = [...this.plan.tasks];
    const newActive = [...this.state.active_tasks];

    for (const r of ready) {
      initTaskDir(this.runDir, r.id);

      const packet = buildPacket(r, this.plan, this.runDir, {
        designMd,
        taskPlanYaml,
        workdir: this.workdir,
      });

      // 取派发前 base_ref / fs snapshot (capabilities 决定是否真采)
      const baseRef = this.capabilities.git_diff
        ? takeGitBaseRef(packet.workdir)
        : null;
      const beforeSnapshot = this.capabilities.fs_snapshot
        ? takeFsSnapshot(packet.workdir)
        : null;

      // attempt 递增 (永远绑定"实际派发次数")
      const newAttempt = r.attempt + 1;

      // 先写 dispatch.json (崩溃恢复: 文件在, 状态机就能重建)
      const meta: DispatchMeta = {
        task_id: r.id,
        dispatched_at: nowUtc().toISOString(),
        base_ref: baseRef,
        before_snapshot: beforeSnapshot,
        attempt: newAttempt,
        packet,
      };
      writeDispatchMeta(this.runDir, r.id, meta);

      // 翻 running + 递增 attempt
      const idx = newTasks.findIndex((t) => t.id === r.id);
      if (idx !== -1) {
        newTasks[idx] = {
          ...newTasks[idx]!,
          status: TaskStatus.running,
          attempt: newAttempt,
        };
      }
      if (!newActive.includes(r.id)) newActive.push(r.id);

      // 同步内部 map (供同进程多次调用用; 跨进程从 dispatch.json 重建)
      this.startedAtByTask.set(r.id, nowUtc());
      if (beforeSnapshot !== null) {
        this.beforeSnapshots.set(r.id, beforeSnapshot);
      }
      if (baseRef !== null) {
        this.baseRefs.set(r.id, baseRef);
      }

      packets.push(packet);
    }

    this.plan = { ...this.plan, tasks: newTasks };
    this.state = { ...this.state, active_tasks: newActive };
    this.refreshStateFile();
    this.refreshPlanFile();

    return packets;
  }

  /**
   * 收回单个 task 的 outcome, 跑 collectOutcome 校验, 推进状态或留 running。
   *
   * 通过: 标 complete + 落 key-diffs/summary/actual-writes + 触发 submitWrapUp (若全完)
   * 失败: 留 running + 落 collect-failures.json + 不递增 attempt (由下次 dispatch 递增)
   * plan_amendment: 自动 handlePlanAmendment + 返回 reason="plan_amendment"
   *
   * bootstrap 降级: dispatch.json 不存在但磁盘有 artifact → 用空 base_ref/snapshot 降级,
   * actual_writes 退化为 worker_self_report (主 agent 看 actual_writes_source 判断可信度)。
   *
   * @throws Error phase≠IMPLEMENTING 或 plan 为空
   */
  collectTaskOutcome(taskId: string): CollectCliResult {
    if (this.state.phase !== Phase.IMPLEMENTING) {
      throw new Error(
        `collectTaskOutcome 必须在 IMPLEMENTING phase (当前 ${this.state.phase})`,
      );
    }
    if (this.plan === null) {
      throw new Error("collectTaskOutcome 时 plan 为空");
    }

    const maxRetries = this.state.config.max_retries_per_task;
    const designMd = path.join(this.runDir, "planning", "design.md");
    const taskPlanYaml = path.join(this.runDir, "planning", "task-plan.yaml");

    const taskIdx = this.plan.tasks.findIndex((t) => t.id === taskId);
    if (taskIdx === -1) {
      return this.mkCollectResult(taskId, {
        verified: false,
        reason: "not_found",
        task_check_all_pass: false,
        failures: [],
        oob_paths: [],
        actual_writes_source: "unavailable",
        advanced_to: "",
        all_complete: false,
        attempt: 0,
        max_retries_per_task: maxRetries,
      });
    }
    const task = this.plan.tasks[taskIdx]!;

    if (task.status !== TaskStatus.running) {
      return this.mkCollectResult(taskId, {
        verified: false,
        reason: "not_running",
        task_check_all_pass: false,
        failures: [],
        oob_paths: [],
        actual_writes_source: "unavailable",
        advanced_to: "",
        all_complete: false,
        attempt: task.attempt,
        max_retries_per_task: maxRetries,
      });
    }

    // 读 dispatch.json (bootstrap 降级关键)
    const meta = readDispatchMeta(this.runDir, taskId);
    const warnings: string[] = [];
    if (meta === null) {
      warnings.push(
        "dispatch.json 不存在 → bootstrap 降级: actual_writes 退化为 worker_self_report (不可信)",
      );
    }
    const packet: WorkerPacket =
      meta?.packet ??
      buildPacket(task, this.plan, this.runDir, {
        designMd,
        taskPlanYaml,
        workdir: this.workdir,
      });

    // 从磁盘重建 outcome
    const outcome = this.reconstructOutcomeFromDisk(taskId);

    // 跨进程 earlierTaskWrites 重建
    const earlierTaskWrites = this.rebuildEarlierTaskWrites();

    // 跑 collectOutcome
    const collected = collectOutcome(
      task,
      outcome,
      packet,
      this.capabilities,
      {
        baseRef: meta?.base_ref ?? null,
        beforeSnapshot: meta?.before_snapshot ?? null,
        earlierTaskWrites,
      },
    );

    // 落 warnings 到日志 (主 agent 可读)
    if (warnings.length > 0) {
      const logPath = path.join(
        this.runDir,
        "tasks",
        taskId,
        "logs",
        "collect-warnings.txt",
      );
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, `${warnings.join("\n")}\n`, "utf-8");
    }

    // 分支 1: plan_amendment
    if (outcome.plan_amendment !== null) {
      this.handlePlanAmendment(outcome.plan_amendment);
      this.refreshStateFile();
      if (this.plan !== null) this.refreshPlanFile();
      return this.mkCollectResult(taskId, {
        verified: false,
        reason: "plan_amendment",
        task_check_all_pass: collected.task_check_result.all_pass,
        failures: collected.task_check_result.items,
        oob_paths: collected.oob.out_of_bounds,
        actual_writes_source: collected.actual_writes.source,
        advanced_to: "",
        all_complete: false,
        attempt: task.attempt,
        max_retries_per_task: maxRetries,
      });
    }

    // 分支 2: 通过 (自检全过 + 无越界)
    if (collected.task_check_result.all_pass && !collected.oob.is_oob) {
      const newTasks = [...this.plan.tasks];
      newTasks[taskIdx] = { ...task, status: TaskStatus.complete };
      this.plan = { ...this.plan, tasks: newTasks };

      const newActive = this.state.active_tasks.filter((id) => id !== taskId);
      this.state = { ...this.state, active_tasks: newActive };

      // 落 key-diffs.yaml
      if (outcome.key_diffs_file !== null) {
        const kdPath = path.join(this.runDir, "tasks", taskId, "key-diffs.yaml");
        fs.mkdirSync(path.dirname(kdPath), { recursive: true });
        fs.writeFileSync(kdPath, dumpKeyDiffsYaml(outcome.key_diffs_file), "utf-8");
        this.keyDiffsByTask.set(taskId, outcome.key_diffs_file);
      }

      // 落 summary.md
      const summaryPath = path.join(this.runDir, "tasks", taskId, "summary.md");
      fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
      fs.writeFileSync(
        summaryPath,
        outcome.summary_text || "(empty summary)",
        "utf-8",
      );

      // 落 actual-writes.json (后续 task collect-outcome 跨进程重建 earlierTaskWrites 用)
      const awData: ActualWritesFile = {
        source: collected.actual_writes.source,
        is_authoritative: collected.actual_writes.is_authoritative,
        writes: [...collected.actual_writes.writes],
      };
      writeActualWrites(this.runDir, taskId, awData);

      // 缓存 (供同进程 + 收口自检用)
      this.taskCheckResults.set(taskId, collected.task_check_result);
      this.earlierTaskWrites.set(taskId, [...collected.actual_writes.writes]);
      this.startedAtByTask.delete(taskId);

      initTaskDir(this.runDir, taskId);

      this.refreshStateFile();
      this.refreshPlanFile();

      // 全完自动 submitWrapUp
      const allComplete =
        this.plan.tasks.length > 0 &&
        this.plan.tasks.every((t) => t.status === TaskStatus.complete);
      if (allComplete && this.state.phase === Phase.IMPLEMENTING) {
        this.submitWrapUp();
      }

      // 下一个 ready task_id 提示
      const nextReady =
        readyFrontier(this.plan.tasks, [])[0]?.id ?? "";

      return this.mkCollectResult(taskId, {
        verified: true,
        reason: "passed",
        task_check_all_pass: true,
        failures: collected.task_check_result.items,
        oob_paths: [],
        actual_writes_source: collected.actual_writes.source,
        advanced_to: nextReady,
        all_complete: allComplete,
        attempt: task.attempt,
        max_retries_per_task: maxRetries,
      });
    }

    // 分支 3: 失败 (留 running, 不递增 attempt)
    const reason =
      outcome.status === "failed"
        ? "failed"
        : collected.oob.is_oob
          ? "oob"
          : "task_check_fail";

    const failures: CollectFailures = {
      task_id: taskId,
      reason,
      failures: collected.task_check_result.items.filter((i) => !i.passed),
      oob_paths: [...collected.oob.out_of_bounds],
      attempt: task.attempt,
      collected_at: nowUtc().toISOString(),
    };
    writeCollectFailures(this.runDir, taskId, failures);

    return this.mkCollectResult(taskId, {
      verified: false,
      reason,
      task_check_all_pass: collected.task_check_result.all_pass,
      failures: collected.task_check_result.items,
      oob_paths: [...collected.oob.out_of_bounds],
      actual_writes_source: collected.actual_writes.source,
      advanced_to: "",
      all_complete: false,
      attempt: task.attempt,
      max_retries_per_task: maxRetries,
    });
  }

  /**
   * 构造 CollectCliResult (补 max_retries_exceeded 计算)。
   *
   * max_retries_exceeded 仅在未通过且 attempt 已达上限时为 true (主 agent 拿决策权)。
   */
  private mkCollectResult(
    taskId: string,
    fields: Omit<CollectCliResult, "max_retries_exceeded" | "task_id">,
  ): CollectCliResult {
    const exceeded =
      !fields.verified &&
      fields.reason !== "not_found" &&
      fields.reason !== "not_running" &&
      fields.attempt >= fields.max_retries_per_task;
    return { ...fields, task_id: taskId, max_retries_exceeded: exceeded };
  }

  /**
   * 从磁盘 artifact 重建 WorkerOutcome (collect-outcome 用)。
   *
   * 读 tasks/<tid>/test-results.yaml + summary.md + key-diffs.yaml, 组装 outcome。
   * 三个文件全缺 → status="failed" (worker 没产出任何东西)。
   * 任一文件 schema 不合法 → 该字段退化为 null (不抛错, 让 task_check 自然判 fail)。
   */
  private reconstructOutcomeFromDisk(taskId: string): WorkerOutcome {
    const base = path.join(this.runDir, "tasks", taskId);

    let testResults: TestResults | null = null;
    const trPath = path.join(base, "test-results.yaml");
    if (fs.existsSync(trPath)) {
      try {
        const raw = yaml.load(fs.readFileSync(trPath, "utf-8"));
        testResults = TestResultsSchema.parse(raw);
      } catch {
        testResults = null;
      }
    }

    let summaryText = "";
    const sumPath = path.join(base, "summary.md");
    if (fs.existsSync(sumPath)) {
      summaryText = fs.readFileSync(sumPath, "utf-8");
    }

    let keyDiffsFile: KeyDiffsFile | null = null;
    const kdPath = path.join(base, "key-diffs.yaml");
    if (fs.existsSync(kdPath)) {
      try {
        const raw = yaml.load(fs.readFileSync(kdPath, "utf-8"));
        keyDiffsFile = KeyDiffsFileSchema.parse(raw);
      } catch {
        keyDiffsFile = null;
      }
    }

    // 三全缺 → failed
    if (testResults === null && summaryText === "" && keyDiffsFile === null) {
      return makeWorkerOutcome({
        status: "failed",
        failure_reason: `no artifacts produced (looked in ${base})`,
      });
    }

    return makeWorkerOutcome({
      status: "completed",
      test_results: testResults,
      summary_text: summaryText,
      key_diffs_file: keyDiffsFile,
    });
  }

  /**
   * 跨进程重建 earlierTaskWrites (越界检测第 2 层用)。
   *
   * 遍历 complete task, 先看内存 map (同进程缓存); 缺则从 actual-writes.json 读。
   * actual-writes.json 缺失 (旧版本/手改) → 该 task 不贡献路径, 保守放过。
   */
  private rebuildEarlierTaskWrites(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    if (this.plan === null) return result;

    for (const task of this.plan.tasks) {
      if (task.status !== TaskStatus.complete) continue;

      const cached = this.earlierTaskWrites.get(task.id);
      if (cached !== undefined) {
        result[task.id] = [...cached];
        continue;
      }

      const aw = readActualWrites(this.runDir, task.id);
      if (aw !== null && Array.isArray(aw.writes)) {
        result[task.id] = aw.writes.filter(
          (x): x is string => typeof x === "string",
        );
      }
    }

    return result;
  }

  /** (公开 readDispatchMeta / actualWritesPath 给 CLI 或测试用; 兼容 export) */
  static readonly dispatchMetaPath = dispatchMetaPath;
  static readonly actualWritesPath = actualWritesPath;

  // ------------------------------------------------------------------
  // tick 循环
  // ------------------------------------------------------------------
  /** 跑一次 tick (用 self 持有的 state / plan / runner)。 */
  runTick(): TickResult {
    if (this.plan === null) {
      throw new Error("runTick 时 plan 为空 (先 submitPlan)");
    }
    const designMd = path.join(this.runDir, "planning", "design.md");
    const taskPlanYaml = path.join(this.runDir, "planning", "task-plan.yaml");
    // 设计文档不存在时建一个占位 (MVP), 避免阻塞测试。
    if (!fs.existsSync(designMd)) {
      fs.mkdirSync(path.dirname(designMd), { recursive: true });
      fs.writeFileSync(designMd, "# Design (placeholder)\n", "utf-8");
    }

    const [newState, newPlan, result] = tick(
      this.state,
      this.plan,
      this.runner,
      this.tickRuntime(),
      {
        now: nowUtc(),
        capabilities: this.capabilities,
        designMd,
        taskPlanYaml,
        runDir: this.runDir,
        workdir: this.workdir,
      },
    );
    this.state = newState;
    this.plan = newPlan;

    // 处理 plan_amendment 信号 (自动 computeRollback + apply + 回 PLANNING)。
    if (result.plan_amendments.length > 0) {
      for (const collected of result.plan_amendments) {
        this.handlePlanAmendment(collected.outcome.plan_amendment);
      }
    }

    // 回填 completed task 的 key_diffs / task_check 结果给收口自检用。
    for (const collected of result.completed_results) {
      this.taskCheckResults.set(collected.task_id, collected.task_check_result);
      this.keyDiffsByTask.set(collected.task_id, collected.outcome.key_diffs_file);
      // 把 key-diffs 落盘到 tasks/<id>/key-diffs.yaml (若 worker 提交了)。
      if (collected.outcome.key_diffs_file !== null) {
        const kdPath = path.join(this.runDir, "tasks", collected.task_id, "key-diffs.yaml");
        fs.mkdirSync(path.dirname(kdPath), { recursive: true });
        fs.writeFileSync(kdPath, dumpKeyDiffsYaml(collected.outcome.key_diffs_file), "utf-8");
      }
      // 落盘 summary.md。
      const summaryPath = path.join(this.runDir, "tasks", collected.task_id, "summary.md");
      fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
      fs.writeFileSync(
        summaryPath,
        collected.outcome.summary_text || "(empty summary)",
        "utf-8",
      );
      // 建 task 目录。
      initTaskDir(this.runDir, collected.task_id);
    }

    // 持久化 (tick 后)。
    this.refreshStateFile();
    if (this.plan !== null) this.refreshPlanFile();

    // 若所有 task 都 complete 且 phase=IMPLEMENTING → 自动 submitWrapUp。
    if (
      this.state.phase === Phase.IMPLEMENTING &&
      this.plan !== null &&
      this.plan.tasks.length > 0 &&
      this.plan.tasks.every((t) => t.status === "complete")
    ) {
      this.submitWrapUp();
    }

    return result;
  }

  /** 循环跑 tick, 直到 isAwaitingHuman 或 isTerminal。 */
  runUntilHumanOrTerminal(maxTicks = 100): void {
    for (let i = 0; i < maxTicks; i += 1) {
      if (isTerminal(this.state.phase)) return;
      if (isAwaitingHuman(this.state)) return;
      this.runTick();
    }
    // 达到 maxTicks 不算错误 (调用方可能继续), 但典型场景下应早于人/终态结束。
  }

  // ------------------------------------------------------------------
  // plan amendment
  // ------------------------------------------------------------------
  /**
   * 处理 plan-amendment: computeRollback + apply + 回 PLANNING。
   *
   * changes_semantics=true (改了 AC 语义) → 回 PLANNING 等人重新拍板。
   */
  handlePlanAmendment(amendment: PlanAmendmentNeeded | null): void {
    if (amendment === null || this.plan === null) return;
    const rollback = computeRollback(this.plan, amendment, true);
    this.plan = applyRollback(this.plan, rollback);
    // 把回滚摘要写到 tasks/<id>/logs/plan-amendment.txt。
    const touched = [...rollback.downgrade_to_pending, ...rollback.recall_to_pending];
    if (touched.length > 0) {
      const text = summarize(rollback);
      for (const tid of touched) {
        const logPath = path.join(this.runDir, "tasks", tid, "logs", "plan-amendment.txt");
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.writeFileSync(logPath, text, "utf-8");
      }
    }
    // changes_semantics=true → 回 PLANNING 等人重新拍板。
    if (rollback.changes_semantics && this.state.phase === Phase.IMPLEMENTING) {
      this.state = advancePhase(this.state, Phase.PLANNING);
      this.state = setHumanPending(this.state, HumanPending.plan_signoff);
    }
  }
}
