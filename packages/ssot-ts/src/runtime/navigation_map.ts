import * as fs from "node:fs";
import * as path from "node:path";

import { Phase, type RunState } from "../schema/run_state.js";
import { TaskStatus, type TaskPlan } from "../schema/task_plan.js";

export type NavigationPhaseStatus = "done" | "current" | "blocked" | "pending";

export interface NavigationPhase {
  readonly phase: Phase;
  readonly status: NavigationPhaseStatus;
  readonly detail: string;
  readonly evidence_paths: string[];
}

/**
 * blocker 只表示"真异常/真失败", 不含人盯锚点。
 * human_pending (plan_signoff / wrap_up_signoff) 是 run 的正常停顿, 单列在 NavigationMap.human_pending。
 */
export interface NavigationBlocker {
  readonly kind:
    | "aborted"
    | "plan_check_failed"
    | "task_failed"
    | "wrap_up_failed";
  readonly reason: string;
  readonly evidence_paths: string[];
}

export interface NavigationTaskSummary {
  readonly pending: number;
  readonly running: number;
  readonly blocked: number;
  readonly complete: number;
}

export interface NavigationMap {
  readonly run_id: string;
  readonly current_phase: Phase;
  readonly human_pending: string | null;
  readonly task_summary: NavigationTaskSummary;
  readonly blocker: NavigationBlocker | null;
  readonly next_action: string;
  readonly phases: NavigationPhase[];
}

const PHASE_ORDER: readonly Phase[] = [
  Phase.CREATED,
  Phase.CLARIFYING,
  Phase.PLANNING,
  Phase.IMPLEMENTING,
  Phase.WRAPPING_UP,
  Phase.COMPLETE,
];

function relEvidence(runDir: string, parts: string[]): string[] {
  return parts.filter((p) => fs.existsSync(path.join(runDir, p)));
}

function summarizeTasks(plan: TaskPlan | null): NavigationTaskSummary {
  const summary = { pending: 0, running: 0, blocked: 0, complete: 0 };
  if (plan === null) return summary;
  for (const task of plan.tasks) {
    if (task.status === TaskStatus.pending) summary.pending += 1;
    if (task.status === TaskStatus.running) summary.running += 1;
    if (task.status === TaskStatus.blocked) summary.blocked += 1;
    if (task.status === TaskStatus.complete) summary.complete += 1;
  }
  return summary;
}

/**
 * 找第一个"失败"的 task 及其证据。覆盖两条真实失败路径:
 * - dispatch/collect 路径 (主 agent 真实 run): 自检失败 → task 留 running + 写
 *   collect-failures.json (coordinator.ts collectTaskOutcome 分支3, 不翻 blocked)。
 * - tick watchdog 路径 (dry-run): 二次回收 → task 翻 blocked (logs/watchdog.json)。
 * 正常 running 且无 collect-failures.json 不算失败 (worker 仍在跑), 避免误报。
 */
function firstFailedTask(
  runDir: string,
  plan: TaskPlan | null,
): { id: string; evidence: string[] } | null {
  if (plan === null) return null;
  for (const task of plan.tasks) {
    // 证据路径值统一用正斜杠相对路径 (与本模块其它字面量如 "planning/plan-check-failures.json"
    // 一致, 也是 renderNavigationMap 输出与跨平台稳定断言所依赖的契约); 存在性检查时再由
    // relEvidence 的 path.join(runDir, p) 归一化为 OS 路径。切勿用 path.join 构造这两个值,
    // 否则 Windows 下会变成反斜杠, 破坏输出契约。
    const cf = `tasks/${task.id}/collect-failures.json`;
    const wd = `tasks/${task.id}/logs/watchdog.json`;
    if (task.status === TaskStatus.blocked) {
      const existing = relEvidence(runDir, [cf, wd]);
      return { id: task.id, evidence: existing.length > 0 ? existing : [cf] };
    }
    if (
      task.status === TaskStatus.running &&
      fs.existsSync(path.join(runDir, cf))
    ) {
      return { id: task.id, evidence: [cf] };
    }
  }
  return null;
}

function wrapUpFailures(runDir: string): string[] {
  const rel = "wrap-up/check-result.json";
  const abs = path.join(runDir, rel);
  if (!fs.existsSync(abs)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(abs, "utf-8")) as Array<{ passed?: boolean }>;
    return parsed.some((item) => item.passed === false) ? [rel] : [];
  } catch {
    return [rel];
  }
}

function detectBlocker(
  runDir: string,
  state: RunState,
  plan: TaskPlan | null,
): NavigationBlocker | null {
  if (state.phase === Phase.ABORTED) {
    return {
      kind: "aborted",
      reason: state.aborted_reason ?? "run aborted",
      evidence_paths: ["run-state.json"],
    };
  }
  // 注意: human_pending 不是 blocker (它是正常人盯锚点), 这里不处理。
  // plan 自检失败: 仅当 PLANNING 且尚未通过 (human_pending 为空)。
  // 通过后会 set human_pending=plan_signoff, 但 plan-check-failures.json 不会被删除,
  // 故用 human_pending 为空区分"仍失败"与"已通过等签字" (否则旧失败文件会误报)。
  const planFailures = relEvidence(runDir, ["planning/plan-check-failures.json"]);
  if (
    planFailures.length > 0 &&
    state.phase === Phase.PLANNING &&
    (state.human_pending === null || state.human_pending === undefined)
  ) {
    return {
      kind: "plan_check_failed",
      reason: "planning gate failed",
      evidence_paths: planFailures,
    };
  }
  // task 失败 (两条路径): running+collect-failures.json 或 watchdog blocked。
  if (state.phase === Phase.IMPLEMENTING) {
    const failed = firstFailedTask(runDir, plan);
    if (failed !== null) {
      return {
        kind: "task_failed",
        reason: `task ${failed.id} failed`,
        evidence_paths: failed.evidence,
      };
    }
  }
  // wrap-up 失败: 即使 human_pending=wrap_up_signoff 也并存上报,
  // 让 operator 知道"去签字, 但收口自检没过, 应 reject"。
  const wrapFailures = wrapUpFailures(runDir);
  if (state.phase === Phase.WRAPPING_UP && wrapFailures.length > 0) {
    return {
      kind: "wrap_up_failed",
      reason: "wrap-up gate failed",
      evidence_paths: wrapFailures,
    };
  }
  return null;
}

function nextAction(state: RunState, blocker: NavigationBlocker | null): string {
  if (state.phase === Phase.ABORTED) return "inspect aborted_reason and start a new run if needed";
  // 收口失败优先于"去签字": 引导 reject 而非误签。
  if (blocker?.kind === "wrap_up_failed") {
    return "reject wrap-up, return to IMPLEMENTING, and repair failing evidence";
  }
  // 人盯锚点是正常下一步 (非失败)。
  if (state.human_pending === "wrap_up_signoff") {
    return "review wrap-up evidence, then run signoff-wrap-up or reject";
  }
  if (state.human_pending === "plan_signoff") {
    return "review the plan, then run signoff-plan or reject with feedback";
  }
  if (blocker?.kind === "plan_check_failed") return "fix planning/task-plan.yaml and rerun plan";
  if (blocker?.kind === "task_failed") return "inspect failed task evidence and dispatch a fix or abort";
  if (state.phase === Phase.CREATED) return "run plan with design and task-plan inputs";
  if (state.phase === Phase.PLANNING) return "submit or repair the plan";
  if (state.phase === Phase.IMPLEMENTING) return "dispatch ready tasks or collect running task outcomes";
  if (state.phase === Phase.WRAPPING_UP) return "review wrap-up evidence";
  if (state.phase === Phase.COMPLETE) return "run complete";
  return "continue lifecycle";
}

function phaseDetail(phase: Phase, state: RunState, summary: NavigationTaskSummary): string {
  if (phase === Phase.CREATED) return "run initialized";
  if (phase === Phase.CLARIFYING) return "optional clarification phase";
  if (phase === Phase.PLANNING) return state.human_pending === "plan_signoff" ? "waiting for plan signoff" : "planning evidence";
  if (phase === Phase.IMPLEMENTING) {
    return `tasks pending=${summary.pending}, running=${summary.running}, blocked=${summary.blocked}, complete=${summary.complete}`;
  }
  if (phase === Phase.WRAPPING_UP) return state.human_pending === "wrap_up_signoff" ? "waiting for wrap-up signoff" : "wrap-up evidence";
  if (phase === Phase.COMPLETE) return "terminal success";
  return "terminal abort";
}

export function buildNavigationMap(
  runDir: string,
  state: RunState,
  plan: TaskPlan | null,
): NavigationMap {
  const summary = summarizeTasks(plan);
  const blocker = detectBlocker(runDir, state, plan);
  const currentIndex = PHASE_ORDER.indexOf(state.phase);
  const phases = PHASE_ORDER.map((phase, idx): NavigationPhase => {
    const status: NavigationPhaseStatus =
      state.phase === Phase.ABORTED
        ? "pending"
        : idx < currentIndex
          ? "done"
          : idx === currentIndex
            ? blocker === null
              ? "current"
              : "blocked"
            : "pending";
    return {
      phase,
      status,
      detail: phaseDetail(phase, state, summary),
      evidence_paths: relEvidence(runDir, evidenceCandidatesForPhase(phase)),
    };
  });

  if (state.phase === Phase.ABORTED) {
    phases.push({
      phase: Phase.ABORTED,
      status: "blocked",
      detail: state.aborted_reason ?? "run aborted",
      evidence_paths: ["run-state.json"],
    });
  }

  return {
    run_id: state.run_id,
    current_phase: state.phase,
    human_pending: state.human_pending ?? null,
    task_summary: summary,
    blocker,
    next_action: nextAction(state, blocker),
    phases,
  };
}

function evidenceCandidatesForPhase(phase: Phase): string[] {
  if (phase === Phase.CREATED) return ["input/requirement.md", "run-state.json"];
  if (phase === Phase.CLARIFYING) return ["clarification/questions.json", "clarification/answers.json"];
  if (phase === Phase.PLANNING) return ["planning/design.md", "planning/task-plan.yaml", "planning/plan-check-failures.json"];
  if (phase === Phase.IMPLEMENTING) return ["tasks"];
  if (phase === Phase.WRAPPING_UP) return ["wrap-up/check-result.json"];
  if (phase === Phase.COMPLETE) return ["run-state.json"];
  return ["run-state.json"];
}
