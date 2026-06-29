/**
 * D. Stop —— 人工锚点 + §8 完成定义 (规范源: design §1 / §2 / §8;
 * 行为权威: Python `hooks/loop_engineering/guard_anchors.py`)。
 *
 * 主 agent 准备结束回合时:
 *   - 无活跃 run / phase ∈ {COMPLETE, ABORTED, ""} → 放行 (用户在做别的事)
 *   - human_pending ∈ {clarification, plan_signoff, wrap_up_signoff} → 放行 (合法人锚点)
 *   - CREATED / CLARIFYING → 放行 (允许 agent 推进到 PLANNING / PLANNING 锚点)
 *   - IMPLEMENTING → 活跃 task 必须 test-results.yaml 落盘且 tests_green=true
 *   - PLANNING → 读 planning/plan-check-failures.json; 存在则 deny (上次 submitPlan 失败)
 *   - WRAPPING_UP → 读 wrap-up/check-result.json; 任一 item 未 pass 则 deny
 *
 * Hook 不重跑 SSOT 算法 (避免循环依赖与重复计算), 只读 Coordinator 在 submitPlan /
 * submitWrapUp 写下的"结果文件", 把它的结论转成 Stop hook 的 allow/deny 决策。
 *
 * 自检不过 → decision=deny; reason 含 "phase" 或失败项明细。
 *
 * 异常 fail-safe = deny (Python main except 分支), 但带上明确 reason。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";
import type { HookInput, HookOutput } from "../../types.js";
import {
  deny,
  findActiveTask,
  passSilent,
  safeReadRunState,
  safeReadTaskPlan,
} from "../common.js";
import { findActiveRun } from "../../runs.js";
import type { HumanPending } from "../../run_state.js";

/**
 * 合法人工锚点 (design §1 / §8.1)。
 * 方法论演进 (2026-06-28): 删除 clarification 锚点 (澄清不再单独停人);
 * CREATED/CLARIFYING 仍按 phase 放行 (见下方 main), 与锚点无关。
 */
const LEGAL_ANCHORS: ReadonlySet<HumanPending> = new Set([
  "plan_signoff",
  "wrap_up_signoff",
]);

// ---------------------------------------------------------------------------
// test-results.yaml 解析 (与 post_task_collect.logic 复用思路, 但本 hook 独立读)
// ---------------------------------------------------------------------------

interface TestResultsShape {
  tests_green?: boolean;
  [k: string]: unknown;
}

/** 解析 test-results.yaml 的 tests_green; schema 不合法抛错。 */
function readTestResultsGreen(p: string): boolean {
  const text = fs.readFileSync(p, "utf-8");
  const data = yaml.load(text) as unknown;
  if (typeof data !== "object" || data === null) {
    throw new Error("test-results.yaml 顶层非 object");
  }
  const tr = data as TestResultsShape;
  if (typeof tr.tests_green !== "boolean") {
    throw new Error("test-results.yaml.tests_green 不是 boolean");
  }
  return tr.tests_green;
}

// ---------------------------------------------------------------------------
// 各 phase 自检
// ---------------------------------------------------------------------------

interface PhaseCheck {
  ok: boolean;
  detail: string;
}

// plan-check-failures.json / wrap-up/check-result.json 的 item 结构 (Coordinator 写入)。
interface CheckFileItem {
  check: string;
  passed: boolean;
  detail: string;
}

/**
 * 读 Coordinator 在 submitPlan 失败时写的 planning/plan-check-failures.json。
 * 文件不存在 → null (submitPlan 还没跑过 / 上次通过了)。
 */
function readPlanCheckFailures(runDir: string): CheckFileItem[] | null {
  const p = path.join(runDir, "planning", "plan-check-failures.json");
  if (!fs.existsSync(p)) return null;
  try {
    const text = fs.readFileSync(p, "utf-8");
    const data = JSON.parse(text) as unknown;
    if (!Array.isArray(data)) return null;
    return data.filter(
      (x): x is CheckFileItem =>
        typeof x === "object" &&
        x !== null &&
        typeof (x as CheckFileItem).check === "string" &&
        typeof (x as CheckFileItem).passed === "boolean" &&
        typeof (x as CheckFileItem).detail === "string",
    );
  } catch {
    return null;
  }
}

/**
 * 读 Coordinator 在 submitWrapUp 写的 wrap-up/check-result.json。
 * 文件不存在 → null (submitWrapUp 还没跑过)。
 */
function readWrapUpCheckResult(runDir: string): CheckFileItem[] | null {
  const p = path.join(runDir, "wrap-up", "check-result.json");
  if (!fs.existsSync(p)) return null;
  try {
    const text = fs.readFileSync(p, "utf-8");
    const data = JSON.parse(text) as unknown;
    if (!Array.isArray(data)) return null;
    return data.filter(
      (x): x is CheckFileItem =>
        typeof x === "object" &&
        x !== null &&
        typeof (x as CheckFileItem).check === "string" &&
        typeof (x as CheckFileItem).passed === "boolean" &&
        typeof (x as CheckFileItem).detail === "string",
    );
  } catch {
    return null;
  }
}

/**
 * PLANNING phase 自检: 检查 plan_check 是否失败过。
 *
 * 读 planning/plan-check-failures.json:
 *   - 不存在 → submitPlan 还没跑过或上次通过了 → 软通过 (让 agent 推进到 plan_signoff)
 *   - 存在且非空 → 上次 submitPlan 失败, 列出失败项 → deny
 *   - 存在但为空 → 退化通过 (异常状态, 不锁死)
 */
function checkPlanningPhase(runDir: string): PhaseCheck {
  const failures = readPlanCheckFailures(runDir);
  if (failures === null) {
    return { ok: true, detail: "planning/plan-check-failures.json 不存在 (plan_check 未失败或未跑)" };
  }
  if (failures.length === 0) {
    return { ok: true, detail: "planning/plan-check-failures.json 为空" };
  }
  const lines = failures.map((f) => `  - ${f.check}: ${f.detail}`).join("\n");
  return {
    ok: false,
    detail: `plan_check 失败 (${failures.length} 项):\n${lines}`,
  };
}

/**
 * WRAPPING_UP phase 自检: 检查 wrap_up_check 是否全 pass。
 *
 * 读 wrap-up/check-result.json:
 *   - 不存在 → submitWrapUp 还没跑过 → 软通过 (异常路径, 通常 WRAPPING_UP 时已存在)
 *   - 存在但任一 item passed=false → deny, 列出失败项
 *   - 全 pass → 通过
 */
function checkWrappingUpPhase(runDir: string): PhaseCheck {
  const items = readWrapUpCheckResult(runDir);
  if (items === null) {
    return { ok: true, detail: "wrap-up/check-result.json 不存在 (submitWrapUp 未跑)" };
  }
  const failed = items.filter((i) => !i.passed);
  if (failed.length === 0) {
    return { ok: true, detail: `wrap_up_check 全 pass (${items.length} 项)` };
  }
  const lines = failed.map((f) => `  - ${f.check}: ${f.detail}`).join("\n");
  return {
    ok: false,
    detail: `wrap_up_check 未全 pass (${failed.length}/${items.length} 项失败):\n${lines}`,
  };
}

/**
 * IMPLEMENTING phase 自检: 当前活跃 task 必须 test-results.yaml 落盘且 tests_green=true。
 *
 * 与 Python `_check_implementing_phase` 等价 (轻量校验, 不重建 WorkerOutcome)。
 */
function checkImplementingPhase(
  runDir: string,
): PhaseCheck {
  const state = safeReadRunState({ cwd: "", runDir });
  const plan = safeReadTaskPlan(runDir);
  if (plan === null) {
    return { ok: false, detail: "IMPLEMENTING 但 task-plan.yaml 缺失" };
  }
  const task = findActiveTask(plan, state);
  if (task === null) {
    // 没有 running 的 task, 可能是 task 间过渡 → 放行
    return { ok: true, detail: "无 status=running 的 task (过渡态)" };
  }
  const trPath = path.join(runDir, "tasks", task.id, "test-results.yaml");
  if (!fs.existsSync(trPath)) {
    return {
      ok: false,
      detail:
        `task ${task.id} status=running 但 test-results.yaml 未落盘; ` +
        "task 未完成不应停止 (§0.4 artifact-first)",
    };
  }
  let green: boolean;
  try {
    green = readTestResultsGreen(trPath);
  } catch (e) {
    return {
      ok: false,
      detail:
        `task ${task.id} test-results.yaml 解析失败: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!green) {
    return {
      ok: false,
      detail:
        `task ${task.id} tests_green=False (机械求值), 未到 task 完成锚点 (§8)`,
    };
  }
  return { ok: true, detail: `task ${task.id} 自检通过` };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * guard_anchors 主入口 (Python `main` 等价)。
 *
 * 异常 fail-safe = deny (Python main except 分支)。
 */
export async function handle(input: HookInput): Promise<HookOutput> {
  try {
    const active = findActiveRun(input.cwd);
    if (active === null) {
      // 无活跃 run → 用户在做别的事, 放行
      return passSilent();
    }

    const state = safeReadRunState({ ...input, runDir: active.runDir });
    if (state === null) {
      // run 目录存在但 run-state.json 缺失 → 不归本 hook 管
      return passSilent();
    }

    const phase = state.phase as string;
    if (phase === "COMPLETE" || phase === "ABORTED" || phase === "") {
      return passSilent();
    }

    const hp = state.human_pending ?? null;
    if (hp !== null && LEGAL_ANCHORS.has(hp)) {
      // 合法人工锚点: 等人介入, 放行
      return passSilent();
    }

    if (phase === "CREATED" || phase === "CLARIFYING") {
      // CREATED / CLARIFYING 且无 human_pending → 自动模式, 允许 agent 继续推进
      return passSilent();
    }

    let check: PhaseCheck;
    if (phase === "IMPLEMENTING") {
      check = checkImplementingPhase(active.runDir);
    } else if (phase === "PLANNING") {
      check = checkPlanningPhase(active.runDir);
    } else if (phase === "WRAPPING_UP") {
      check = checkWrappingUpPhase(active.runDir);
    } else {
      // 未识别 phase (未来扩展): 退化放行
      return passSilent();
    }

    if (check.ok) return passSilent();
    return deny(
      `phase=${phase} 未到合法锚点且自检未过: ${check.detail}. ` +
        "必须先到达 plan_signoff 或 wrap_up_signoff 锚点 (§1 / §8).",
    );
  } catch (e) {
    return deny(
      `guard_anchors hook 内部错误: ${e instanceof Error ? e.stack ?? e.message : String(e)}`,
    );
  }
}

/*
 * 用例预期 (从 Python tests/test_hooks_smoke.py 翻译, T5 落地):
 *
 *   1. 无活跃 run → allow
 *   2. phase=COMPLETE → allow
 *   3. phase=IMPLEMENTING + human_pending=plan_signoff → allow (合法人锚点)
 *   4. phase=IMPLEMENTING + human_pending=wrap_up_signoff → allow
 *   5. phase=IMPLEMENTING + 无 human_pending + 活跃 task test-results.yaml tests_green=true → allow
 *   6. phase=IMPLEMENTING + 无 human_pending + test-results.yaml 缺失 → deny; reason 含 "test-results.yaml" 和 "IMPLEMENTING"
 *   7. phase=IMPLEMENTING + 无 human_pending + tests_green=false → deny; reason 含 "tests_green"
 *   8. phase=PLANNING + plan-check-failures.json 不存在 → allow (软通过)
 *   9. phase=PLANNING + plan-check-failures.json 存在且非空 → deny; reason 含失败项 check 名
 *   10. phase=WRAPPING_UP + check-result.json 全 pass → allow
 *   11. phase=WRAPPING_UP + check-result.json 任一 fail → deny; reason 含失败项
 *   12. 内部异常 → deny (fail-safe, 不锁死 agent 但提示有错)
 */
