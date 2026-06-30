/**
 * B. PreToolUse:Write/Edit —— 路径白名单 (规范源: design §0.4 artifact-first;
 * 行为权威: Python `hooks/loop_engineering/guard_paths.py`)。
 *
 * 按 file_path 前缀判定合法性。当前 phase + 当前活跃 task + 写者身份 决定哪些路径可写。
 * 规则 (按前缀匹配, 第一个命中生效):
 *   0. (B 案新增) 写者身份治理: 主 agent 写 worker 红线路径 → deny (caller="main" 时生效;
 *      caller=undefined 时跳过本规则, OC 退化到原 phase+task 治理)
 *   1. <repo>/.claude/**              → 永远 deny (保护 skill/agent/hook 自身)
 *   2. <repo>/loop_engineering/**     → 永远 deny (保护 Python SSOT)
 *   3. <repo>/.opencode/**            → 永远 deny (保护 OC 资产)
 *   4. <repo>/runs/<id>/run-state.*   → 永远 allow (协调者写状态)
 *   5. <repo>/runs/<id>/tasks/<tid>/** → 仅当 <tid> 是当前活跃 run 里 status=running 的 task
 *   6. <repo>/runs/<id>/planning/**   → 仅在 phase ∈ {CREATED, CLARIFYING, PLANNING}
 *   7. <repo>/runs/<id>/clarification/** → 仅在 phase ∈ {CREATED, CLARIFYING}
 *   8. <repo>/runs/<id>/wrap-up/**    → 仅在 phase = WRAPPING_UP
 *   9. 其它 <repo>/**                  → 仅在 phase=IMPLEMENTING 且 active task 的
 *                                        allowed_write_paths 覆盖该路径;
 *                                        (B 案) 主 agent 写源码 → deny
 *   10. 其它                            → deny
 *
 * 性能: 每次 Write/Edit 都触发。task-plan 读取加 module-level 缓存 (mtime 失效),
 * 避免重复解析 yaml。
 *
 * 异常 fail-safe = deny (与 probe_and_gate 不同); 但仅在治理 phase 才收紧
 * (无 run / phase 终态 / 读 SSOT 失败 → 静默放行, 不干扰 loop 之外的编辑)。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { HookInput, HookOutput } from "../../types.js";
import { matchPath } from "../../path_match.js";
import {
  deny,
  findActiveTask,
  normalizeToolFilePath,
  passSilent,
  relToRepo,
  safeReadRunState,
  safeReadTaskPlan,
} from "../common.js";
import { findActiveRun } from "../../runs.js";
import type { RunState } from "../../run_state.js";
import type { Task, TaskPlan } from "../../task_plan.js";

/** 治理 phase 集合: 只有这些 phase 下才收紧路径白名单。 */
const GOVERNING_PHASES: ReadonlySet<string> = new Set([
  "CREATED",
  "CLARIFYING",
  "PLANNING",
  "IMPLEMENTING",
  "WRAPPING_UP",
]);

// ---------------------------------------------------------------------------
// task-plan 缓存 (mtime 失效, 避免每次 Write/Edit 重复读 yaml)
// ---------------------------------------------------------------------------

interface CachedPlan {
  runDir: string;
  mtimeMs: number;
  plan: TaskPlan | null;
}

let cachedPlan: CachedPlan | null = null;

/**
 * 读 task-plan (带 mtime 缓存)。
 *
 * 同 runDir + 同 mtime → 返回缓存; 否则重新读 (含"文件不存在→null"的缓存)。
 * 多次 Write/Edit 在同一 task 期间命中缓存, 解析开销摊薄到 1 次。
 */
function readTaskPlanCached(runDir: string): TaskPlan | null {
  const planPath = path.join(runDir, "planning", "task-plan.yaml");
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(planPath).mtimeMs;
  } catch {
    // 文件不存在: 缓存 null (避免反复 stat)
    if (
      cachedPlan &&
      cachedPlan.runDir === runDir &&
      cachedPlan.plan === null
    ) {
      return null;
    }
    cachedPlan = { runDir, mtimeMs: 0, plan: null };
    return null;
  }

  if (
    cachedPlan &&
    cachedPlan.runDir === runDir &&
    cachedPlan.mtimeMs === mtimeMs
  ) {
    return cachedPlan.plan;
  }

  const plan = safeReadTaskPlan(runDir);
  cachedPlan = { runDir, mtimeMs, plan };
  return plan;
}

// ---------------------------------------------------------------------------
// 规则
// ---------------------------------------------------------------------------

/** 规则 1-3: 受保护目录永远 deny (.claude / loop_engineering / .opencode)。 */
function ruleProtected(rel: string): string | null {
  if (matchPath(".claude/**", rel)) {
    return "保护 .claude/ (skill/agent/hook 自身) — 仅用户手工编辑, agent 不可写";
  }
  if (matchPath("loop_engineering/**", rel)) {
    return "保护 Python SSOT (loop_engineering/) — 不可改";
  }
  if (matchPath(".opencode/**", rel)) {
    return "保护 .opencode/ (OC 资产) — 不可改";
  }
  return null;
}

/** 规则 4: runs/<id>/run-state.* 允许 (协调者写状态)。 */
function ruleRunState(rel: string): string | null {
  const parts = rel.split("/");
  // runs/<id>/run-state.<ext>
  if (parts.length === 3 && parts[0] === "runs" && parts[2].startsWith("run-state.")) {
    return "ALLOW";
  }
  return null;
}

/** 规则 5: runs/<id>/tasks/<tid>/**, tid 必须是活跃 task。 */
function ruleTasks(
  rel: string,
  plan: TaskPlan | null,
  state: RunState | null,
): string | null {
  const parts = rel.split("/");
  if (parts.length >= 4 && parts[0] === "runs" && parts[2] === "tasks") {
    const tid = parts[3];
    const active = findActiveTask(plan, state);
    if (active && active.id === tid) return "ALLOW";
    return (
      `runs/.../tasks/${tid}/ 写入被拒: 该 task 不是当前活跃 run 里 ` +
      "status=running 的 task (§0.4 artifact-first)"
    );
  }
  return null;
}

/** 规则 6: runs/<id>/planning/**, phase ∈ {CREATED, CLARIFYING, PLANNING}。 */
function rulePlanning(rel: string, phase: string): string | null {
  const parts = rel.split("/");
  if (parts.length >= 3 && parts[0] === "runs" && parts[2] === "planning") {
    if (phase === "CREATED" || phase === "CLARIFYING" || phase === "PLANNING") {
      return "ALLOW";
    }
    return `planning/ 写入被拒: 当前 phase=${phase}, 仅 CREATED/CLARIFYING/PLANNING 可写`;
  }
  return null;
}

/** 规则 7: runs/<id>/clarification/**, phase ∈ {CREATED, CLARIFYING}。 */
function ruleClarification(rel: string, phase: string): string | null {
  const parts = rel.split("/");
  if (parts.length >= 3 && parts[0] === "runs" && parts[2] === "clarification") {
    if (phase === "CREATED" || phase === "CLARIFYING") return "ALLOW";
    return `clarification/ 写入被拒: 当前 phase=${phase}, 仅 CREATED/CLARIFYING 可写`;
  }
  return null;
}

/** 规则 8: runs/<id>/wrap-up/**, phase = WRAPPING_UP。 */
function ruleWrapUp(rel: string, phase: string): string | null {
  const parts = rel.split("/");
  if (parts.length >= 3 && parts[0] === "runs" && parts[2] === "wrap-up") {
    if (phase === "WRAPPING_UP") return "ALLOW";
    return `wrap-up/ 写入被拒: 当前 phase=${phase}, 仅 WRAPPING_UP 可写`;
  }
  return null;
}

/** 规则 9: 源码 (排除上面 8 类), 仅 IMPLEMENTING 且 active task 覆盖; 主 agent 写源码 deny (B 案)。 */
function ruleSource(
  rel: string,
  phase: string,
  active: Task | null,
  caller: HookInput["caller"],
): string | null {
  if (rel.startsWith("runs/")) {
    // runs/ 下但没被前 8 条匹配 (不规范子路径) → deny
    return `runs/ 内未识别子路径: ${rel}`;
  }
  if (phase !== "IMPLEMENTING") {
    return `源码写入被拒: 当前 phase=${phase}, 仅 IMPLEMENTING 可写源码 (§0.4 artifact-first)`;
  }
  if (active === null) {
    return "源码写入被拒: IMPLEMENTING 但找不到 status=running 的 task";
  }
  // B 案新增: 主 agent 写源码 deny. caller=undefined 时跳过本检查 (OC 退化到原逻辑).
  if (caller === "main") {
    return (
      `主 agent 写源码 ${rel} 被拒: IMPLEMENTING 阶段所有源码改动必须由 ` +
      "implementation-worker 子 agent 产出. 请改用 Task 工具分派 (subagent_type=implementation-worker). " +
      "见 SKILL §1.5 角色边界."
    );
  }
  // 子 agent (implementation-worker) 写: 检查 allowed_write_paths
  const covered = active.allowed_write_paths.some((glob) => matchPath(glob, rel));
  if (covered) return "ALLOW";
  return (
    `源码写入被拒: 路径 ${rel} 不在当前 task ${active.id} 的 ` +
    `allowed_write_paths=[${active.allowed_write_paths.join(", ")}] 范围内`
  );
}

// ---------------------------------------------------------------------------
// 规则 0 (B 案新增): 写者身份治理
// ---------------------------------------------------------------------------

/**
 * 主 agent 直接写 worker 红线路径 → deny. 这是"主 agent 不干活"红线的物理强制.
 *
 * worker 红线路径 (主 agent 不能写):
 *   - planning/{design.md, task-plan.yaml, service-contracts.yaml} (主 agent 仅可写
 *     planning/plan-check-failures.json — Coordinator 跑 plan_check 的产物)
 *   - clarification/questions.json
 *   - tasks/<tid>/{test-results.yaml, summary.md, key-diffs.yaml} (worker 产物;
 *     dispatch.json / collect-*.json / actual-writes.json 仍由主 agent 写)
 *   - wrap-up/red-team-review.md (主 agent 仍可写 wrap-up/key-diffs.md 与
 *     wrap-up/check-result.json, 这是 Coordinator 汇总/检查产物)
 *
 * 跳过条件:
 *   - caller === undefined: 宿主未提供身份信息 (OC), 退化到原 phase+task 治理, 不做身份判定.
 *   - caller !== "main" (即子 agent): 身份治理不拦, 后续规则 1-10 继续生效.
 *
 * 设计取舍: caller=undefined 跳过而非按主 agent 处理, 是因为 OC 当前没有子 agent 概念,
 * 主 agent 直接执行所有任务, 强行身份治理会锁死整个 OC 工作流. CC 真子 agent 一定带
 * agent_id, 故 CC 端主 agent 写一定走 caller="main" 分支被治理.
 */
function ruleWriterIdentity(
  rel: string,
  caller: HookInput["caller"],
): string | null {
  // OC 等宿主无身份信息 → 跳过身份治理, 退化到原 phase+task 治理
  if (caller === undefined) return null;
  // 子 agent 写: 身份治理不拦 (路径白名单规则 1-10 会继续生效)
  if (caller !== "main") return null;

  // 主 agent 写: 检查是否落在 worker 红线路径
  const parts = rel.split("/");

  // planning/** 主 agent 只能写 plan-check-failures.json
  if (parts.length >= 3 && parts[0] === "runs" && parts[2] === "planning") {
    const leaf = parts[parts.length - 1];
    if (leaf !== "plan-check-failures.json") {
      return (
        `主 agent 写 ${rel} 被拒: planning/{design.md, task-plan.yaml, ` +
        "service-contracts.yaml} 必须由 plan-agent 子 agent 产出. 主 agent 仅可写 " +
        "planning/plan-check-failures.json. 请改用 Task 工具分派 plan-agent " +
        "(subagent_type=plan-agent). 见 SKILL §1.5 角色边界."
      );
    }
    return null;
  }

  // clarification/** 主 agent 不能写
  if (
    parts.length >= 3 &&
    parts[0] === "runs" &&
    parts[2] === "clarification"
  ) {
    return (
      `主 agent 写 ${rel} 被拒: clarification/questions.json 必须由 clarification-finder ` +
      "子 agent 产出. 请改用 Task 工具分派 (subagent_type=clarification-finder). " +
      "见 SKILL §1.5 角色边界."
    );
  }

  // tasks/<tid>/{test-results,summary,key-diffs}.* 主 agent 不能写
  if (parts.length >= 4 && parts[0] === "runs" && parts[2] === "tasks") {
    const leaf = parts[parts.length - 1];
    const workerArtifacts = [
      "test-results.yaml",
      "summary.md",
      "key-diffs.yaml",
    ];
    if (workerArtifacts.includes(leaf)) {
      return (
        `主 agent 写 ${rel} 被拒: tasks/<tid>/{test-results.yaml, summary.md, ` +
        "key-diffs.yaml} 必须由 implementation-worker 子 agent 产出. " +
        "请改用 Task 工具分派 (subagent_type=implementation-worker). " +
        "见 SKILL §1.5 角色边界."
      );
    }
    // dispatch.json / collect-*.json / actual-writes.json: 主 agent 可写, 放行
    return null;
  }

  // wrap-up/red-team-review.md 主 agent 不能写
  if (parts.length >= 3 && parts[0] === "runs" && parts[2] === "wrap-up") {
    const leaf = parts[parts.length - 1];
    if (leaf === "red-team-review.md") {
      return (
        `主 agent 写 ${rel} 被拒: wrap-up/red-team-review.md 必须由 red-team-reviewer ` +
        "子 agent 产出. 请改用 Task 工具分派 (subagent_type=red-team-reviewer). " +
        "见 SKILL §1.5 角色边界."
      );
    }
    // wrap-up/check-result.json / wrap-up/key-diffs.md: 主 agent 可写 (Coordinator 汇总/检查)
    return null;
  }

  // 其它路径 (源码等): 不在本规则治理范围, 留给规则 9 (ruleSource) 处理主 agent 写源码的 deny
  return null;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * guard_paths 主入口 (Python `main` 等价)。
 *
 * 异常 fail-safe = deny; 但仅在治理 phase 才进入严格判定, 否则静默放行。
 */
export async function handle(input: HookInput): Promise<HookOutput> {
  try {
    const fp = normalizeToolFilePath(input.toolInput, input.cwd);
    if (fp === null) {
      // 无 file_path 的 Write/Edit (理论不存在), 静默放行
      return passSilent();
    }

    const rel = relToRepo(fp, input.cwd);
    if (rel === null) {
      // 仓库外写入 (临时文件等), 不归本 hook 管
      return passSilent();
    }

    const active = findActiveRun(input.cwd);
    if (active === null) {
      // 无活跃 run: loop 之外的日常编辑不受影响
      return passSilent();
    }

    const state = safeReadRunState({ ...input, runDir: active.runDir });
    if (state === null) {
      // run 目录存在但 run-state 缺失/不可解析 → 无法可靠治理, 退化放行 (§0.4 缺包容忍)
      return passSilent();
    }
    const phase = state.phase;

    // 仅在治理 phase 才收紧
    if (!GOVERNING_PHASES.has(phase)) {
      // COMPLETE / ABORTED / 异常 phase → run 已终态, 不再治理写入
      return passSilent();
    }

    // 规则 0 (B 案): 写者身份治理 — 在所有路径规则之前判定
    // caller=undefined (OC) 时跳过; caller="main" 时拦主 agent 写 worker 红线路径.
    const idMsg = ruleWriterIdentity(rel, input.caller);
    if (idMsg !== null) {
      return deny(`路径白名单拒绝(写者身份): ${fp} (${idMsg})`);
    }

    // 规则 1-3: 受保护目录
    let msg = ruleProtected(rel);
    if (msg !== null) return deny(`路径白名单拒绝: ${fp} (${msg})`);

    // 规则 4: run-state.*
    msg = ruleRunState(rel);
    if (msg !== null) {
      if (msg === "ALLOW") return passSilent();
      return deny(`路径白名单拒绝: ${fp} (${msg})`);
    }

    // 规则 5-8 需要 plan (有则用, 无则降级到"找不到 running task")
    const plan = readTaskPlanCached(active.runDir);

    // 规则 5: tasks/<tid>/**
    msg = ruleTasks(rel, plan, state);
    if (msg !== null) {
      if (msg === "ALLOW") return passSilent();
      return deny(`路径白名单拒绝: ${fp} (${msg})`);
    }

    // 规则 6: planning/**
    msg = rulePlanning(rel, phase);
    if (msg !== null) {
      if (msg === "ALLOW") return passSilent();
      return deny(`路径白名单拒绝: ${fp} (${msg})`);
    }

    // 规则 7: clarification/**
    msg = ruleClarification(rel, phase);
    if (msg !== null) {
      if (msg === "ALLOW") return passSilent();
      return deny(`路径白名单拒绝: ${fp} (${msg})`);
    }

    // 规则 8: wrap-up/**
    msg = ruleWrapUp(rel, phase);
    if (msg !== null) {
      if (msg === "ALLOW") return passSilent();
      return deny(`路径白名单拒绝: ${fp} (${msg})`);
    }

    // 规则 9: 源码 (active task 仅 IMPLEMENTING 时取)
    const active2 =
      phase === "IMPLEMENTING" ? findActiveTask(plan, state) : null;
    msg = ruleSource(rel, phase, active2, input.caller);
    if (msg === "ALLOW") return passSilent();
    return deny(`路径白名单拒绝: ${fp} (${msg})`);
  } catch (e) {
    return deny(`guard_paths hook 内部错误: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  }
}

/*
 * 用例预期 (从 Python tests/test_hooks_smoke.py 翻译, T5 落地):
 *
 *   1. 无活跃 run + 写任意路径 → allow (loop 之外不干扰)
 *   2. IMPLEMENTING + 写 .claude/x → deny; reason 含 ".claude"
 *   3. IMPLEMENTING + 写 loop_engineering/x → deny; reason 含 "loop_engineering"
 *   4. IMPLEMENTING + active task allowed=["src/**"] + 写 src/foo.ts (caller=undefined/OC 或子 agent) → allow
 *   5. IMPLEMENTING + active task allowed=["src/**"] + 写 docs/x.md → deny; reason 含 "allowed_write_paths"
 *   6. PLANNING + 写 planning/design.md (caller=undefined/OC 或子 agent) → allow
 *   7. IMPLEMENTING + 写 planning/design.md → deny; reason 含 "CREATED/CLARIFYING/PLANNING"
 *   8. 写 runs/<id>/run-state.json → allow (协调者写状态)
 *   9. IMPLEMENTING + 写 runs/<id>/tasks/<tid>/summary.md (tid=active, caller=undefined/OC 或子 agent) → allow
 *   10. 内部异常 → deny (不静默放过)
 *
 * B 案新增 (写者身份治理, 见 guard_paths_writer_identity.test.ts):
 *   W1. caller="main" + 写 planning/design.md → deny; reason 含 "plan-agent"
 *   W2. caller="main" + 写 planning/plan-check-failures.json → allow
 *   W3. caller={agent_id, agent_type} + 写 planning/design.md (PLANNING) → allow
 *   W4. caller="main" + 写 tasks/<tid>/summary.md (IMPLEMENTING, tid=active) → deny; reason 含 "implementation-worker"
 *   W5. caller="main" + 写 clarification/questions.json (CLARIFYING) → deny; reason 含 "clarification-finder"
 *   W6. caller="main" + 写 wrap-up/red-team-review.md (WRAPPING_UP) → deny; reason 含 "red-team-reviewer"
 *   W7. caller="main" + 写 wrap-up/key-diffs.md (WRAPPING_UP) → allow (Coordinator 汇总)
 *   W8. caller="main" + IMPLEMENTING + 写源码 src/foo.ts → deny; reason 含 "implementation-worker"
 *   W9. caller="main" + 写 run-state.json → allow
 *   W10. caller=undefined (OC 模拟) + 写 planning/design.md (PLANNING) → allow (退化, 不做身份治理)
 */
