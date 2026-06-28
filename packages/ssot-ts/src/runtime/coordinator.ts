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
import type { TaskCheckResult } from "../checklists/task_check.js";
import { pathGlobsOverlap } from "../scheduling/path_overlap.js";
import { probeCapabilities } from "../scheduling/capabilities.js";
import { isMeaningful } from "../schema/artifacts.js";
import type { KeyDiffsFile, PlanAmendmentNeeded } from "../schema/artifacts.js";
import { parseClarificationQuestions } from "../schema/clarification.js";
import type {
  ClarificationAnswers,
  ClarificationQuestions,
} from "../schema/clarification.js";
import { HumanPending, Phase } from "../schema/run_state.js";
import type { RunCapabilities, RunState } from "../schema/run_state.js";
import { parseServiceContracts } from "../schema/service_contracts.js";
import type { ServiceContracts } from "../schema/service_contracts.js";
import type { TaskPlan } from "../schema/task_plan.js";
import {
  clearHumanPending,
  isAwaitingHuman,
  setHumanPending,
} from "../state_machine/human_anchors.js";
import { advancePhase, isTerminal } from "../state_machine/transitions.js";
import type { WorkerRunner } from "../dispatch/worker_runner.js";
import {
  initTaskDir,
  readRunState,
  readTaskPlan,
  writeRunState,
  writeTaskPlan,
} from "./directory.js";
import type { CollectedTaskResult, FsSnapshot } from "../dispatch/collect.js";
import { tick } from "./tick.js";
import type { TickResult, TickRuntime } from "./tick.js";
import { dumpKeyDiffsYaml } from "./yaml_io.js";

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

    // capabilities 探测 (§3.4 CREATED 时一次性写入 run-state, 此后固定):
    // 反序列化已有 → 沿用; 缺失 → probe 后挂到 state, 由下一次 refreshStateFile 顺带写回
    // (不在构造时立即写, 避免 Windows 文件锁 race + 减少 IO)。
    if (this.state.capabilities === null || this.state.capabilities === undefined) {
      this.capabilities = probeCapabilities(path.dirname(runDir));
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

  /** → PLANNING (从 CREATED 或 CLARIFYING 进)。 */
  startPlanning(): void {
    if (this.state.phase === Phase.CREATED || this.state.phase === Phase.CLARIFYING) {
      this.state = advancePhase(this.state, Phase.PLANNING);
      this.refreshStateFile();
    }
  }

  /**
   * plan agent 提交: 跑 plan_check, 通过则 set human_pending=plan_signoff。
   *
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
    const result = checkPlan(plan, {
      contracts,
      pathOverlapFn: pathGlobsOverlap,
      clarification,
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
    // 通过 → 写 plan + set human_pending=plan_signoff。
    this.refreshPlanFile();
    this.state = setHumanPending(this.state, HumanPending.plan_signoff);
    this.refreshStateFile();
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

  /** → WRAPPING_UP, 跑收口自检, set human_pending=wrap_up_signoff。 */
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

    // 不论通过与否, 都 set human_pending=wrap_up_signoff, 让 runUntilHumanOrTerminal 退出循环
    // (§A4 修复: 失败时若不设 anchor, tick 会空转直到 max_ticks hang)。
    this.state = setHumanPending(this.state, HumanPending.wrap_up_signoff);
    this.refreshStateFile();
  }

  /**
   * 人盯点 2. accepted=true → → COMPLETE; false → 回 IMPLEMENTING。
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
