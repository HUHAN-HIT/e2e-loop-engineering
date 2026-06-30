/**
 * 4 个 hook 的公共底座 (行为权威: Python `hooks/loop_engineering/common.py`)。
 *
 * 统一封装:
 *   - run 目录 / run-state / task-plan 的安全读取 (失败返回 null, 让调用方 fail-safe)
 *   - 当前活跃 task 定位 (plan 中 status=running 且在 state.active_tasks 中)
 *   - 4 类 worker 的 subagent_type 分类
 *
 * 不重写算法: actual_writes / path_overlap / checks / 能力探测都在各自专用模块,
 * 本文件只做"读 SSOT 状态文件 + 简单分类"。
 *
 * 与 Python 的差异:
 *   - Python `active_run_dir` 用 mtime 降序; TS `findActiveRun` 用 run_id 字典序降序
 *     (run_id 格式 YYYYMMDD-NNN, 字典序=时间序), 行为等价且更可预测。
 *   - Python `classify_worker` 的模糊匹配 ("clarification" / "red" 子串) 在 TS 同样实现。
 */

import * as path from "node:path";
import type { HookInput, HookOutput } from "../types.js";
import { readRunState } from "../runs.js";
import { readTaskPlan } from "../task_plan.js";
import type { RunState } from "../run_state.js";
import type { Task, TaskPlan } from "../task_plan.js";

// HookInput 在 SafeReadOptions 里以可选字段呈现, safeReadRunState 实际只看 runDir。
interface SafeReadOptions {
  runDir?: string;
}

// ---------------------------------------------------------------------------
// 4 类 worker 的 subagent_type 标识 (与 .claude/agents/<name>.md 对应)
// ---------------------------------------------------------------------------

export const WORKER_IMPLEMENTATION = "implementation-worker";
export const WORKER_PLAN = "plan-agent";
export const WORKER_CLARIFICATION = "clarification-finder";
export const WORKER_RED_TEAM = "red-team-reviewer";

export type WorkerName =
  | typeof WORKER_IMPLEMENTATION
  | typeof WORKER_PLAN
  | typeof WORKER_CLARIFICATION
  | typeof WORKER_RED_TEAM;

/**
 * 从 Task 工具的 tool_input 推断 worker 类型 (Python `classify_worker` 等价)。
 *
 * 匹配 subagent_type 字段, 兼容大小写 / 子串。无匹配返回 null (非 loop-engineering worker)。
 */
export function classifyWorker(toolInput: unknown): WorkerName | null {
  if (typeof toolInput !== "object" || toolInput === null) return null;
  const st = String(
    (toolInput as Record<string, unknown>).subagent_type ?? "",
  ).toLowerCase();
  if (!st) return null;
  if (st.includes(WORKER_IMPLEMENTATION)) return WORKER_IMPLEMENTATION;
  if (st.includes(WORKER_PLAN)) return WORKER_PLAN;
  if (st.includes(WORKER_CLARIFICATION) || st.includes("clarification"))
    return WORKER_CLARIFICATION;
  if (st.includes(WORKER_RED_TEAM) || st.includes("red"))
    return WORKER_RED_TEAM;
  return null;
}

// ---------------------------------------------------------------------------
// 写者身份 (B 案新增, guard_paths 用)
// ---------------------------------------------------------------------------

/**
 * 判定 hook 调用方是否为主 agent (B 案新增).
 *
 * - caller === "main" → true (主 agent 直接调工具)
 * - caller === { agent_id, ... } → false (子 agent 调工具)
 * - caller === undefined → true (宿主未提供身份信息, 保守按主 agent 处理)
 *
 * 设计取舍: undefined 默认 "main" 而非 "worker":
 *   1. guard_paths 在 caller===undefined 时单独判定是否进入身份治理 (见 ruleWriterIdentity);
 *      真要做身份治理时, undefined 视为主 agent 才能拦住"主 agent 借未支持宿主绕过分派".
 *   2. CC 真子 agent 一定带 agent_id; 真正的 worker 不会被误判.
 *
 * 注意: guard_paths 当前实现是 caller===undefined 时**跳过**身份治理 (OC 退化), 与
 * 本函数无关; 本函数仅供未来扩展 (post_task_collect / guard_anchors 等) 复用.
 */
export function isMainAgent(
  input: Pick<HookInput, "caller">,
): boolean {
  if (input.caller === undefined) return true;
  return input.caller === "main";
}

// ---------------------------------------------------------------------------
// run-state / task-plan 读取
// ---------------------------------------------------------------------------

/**
 * 安全读 run-state; runDir 缺失 / 文件不存在 / 解析失败均返回 null。
 *
 * 接受部分 HookInput (只要有 runDir 字段), 让没有完整 HookInput 的内部辅助
 * (如 guard_anchors 的 checkImplementingPhase) 也能调用。
 */
export function safeReadRunState(input: SafeReadOptions | HookInput): RunState | null {
  if (!input.runDir) return null;
  return readRunState(input.runDir);
}

/**
 * 安全读 task-plan; runDir 缺失 / 文件不存在 / 解析失败均返回 null。
 *
 * 注意: 调用方应按 phase 决定是否需要读 plan (CLARIFYING 之前不必), 避免无谓 IO。
 */
export function safeReadTaskPlan(runDir: string): TaskPlan | null {
  return readTaskPlan(runDir);
}

// ---------------------------------------------------------------------------
// 活跃 task 定位 (Python `find_active_task` 等价)
// ---------------------------------------------------------------------------

/**
 * 从 plan + state 找当前 status=running 的 task。
 *
 * 优先 plan 中 status="running" 且 id 在 state.active_tasks 中的; 若 state.active_tasks
 * 为空, 则 plan 中第一个 running task 即活跃 (与 Python 一致)。找不到返回 null。
 */
export function findActiveTask(
  plan: TaskPlan | null,
  state: RunState | null,
): Task | null {
  if (!plan) return null;
  const activeIds = new Set(state?.active_tasks ?? []);
  for (const t of plan.tasks) {
    if (t.status !== "running") continue;
    // state.active_tasks 有内容时进一步校验; 否则 plan 里 running 即活跃
    if (activeIds.size === 0 || activeIds.has(t.id)) return t;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 路径规范化 (guard_paths 用)
// ---------------------------------------------------------------------------

/**
 * 从 tool_input 取 file_path 并规范化 (Python `_normalize_file_path` 等价)。
 *
 * 处理 file:// URL / 相对路径; 相对路径相对 repoRoot 解析。无 file_path 返回 null。
 */
export function normalizeToolFilePath(
  toolInput: unknown,
  repoRoot: string,
): string | null {
  if (typeof toolInput !== "object" || toolInput === null) return null;
  const k = toolInput as Record<string, unknown>;
  const raw = k.file_path ?? k.path;
  if (typeof raw !== "string" || raw === "") return null;

  let s = raw;
  if (s.startsWith("file://")) {
    try {
      s = decodeURIComponent(s.slice("file://".length));
    } catch {
      s = s.slice("file://".length);
    }
  }

  const abs = path.isAbsolute(s) ? s : path.resolve(repoRoot, s);
  try {
    return path.resolve(abs); // 规范化 .. / .
  } catch {
    return abs;
  }
}

/** 返回相对 repoRoot 的 POSIX 路径; 不在 repo 内返回 null。 */
export function relToRepo(absPath: string, repoRoot: string): string | null {
  const rel = path.relative(path.resolve(repoRoot), path.resolve(absPath));
  if (rel === "" || rel === ".") return ".";
  if (rel.startsWith("..")) return null; // 仓库外
  return rel.replace(/\\/g, "/");
}

// ---------------------------------------------------------------------------
// HookOutput 便捷构造 (Python emit_block / emit_pass_silent / additional_context 等价)
// ---------------------------------------------------------------------------

/** 静默放行 (decision=allow, 无 reason 无 context)。 */
export function passSilent(): HookOutput {
  return { decision: "allow" };
}

/**
 * 拒绝并把 reason 注入工具调用结果 (decision=deny)。
 * Python `emit_block` 等价; adapter binding 时翻译成 CC 的 `{decision: "block", reason}`。
 */
export function deny(reason: string): HookOutput {
  return { decision: "deny", reason };
}

/**
 * 注入主 agent 下一轮的上下文后放行 (decision=defer)。
 *
 * Python `emit(additional_context(payload))` 等价; adapter binding 时翻译成 CC 的
 * `hookSpecificOutput.additionalContext` (JSON 字符串) 或 OC 的 plugin notice。
 */
export function injectContext(
  payload: Record<string, unknown>,
  reason?: string,
): HookOutput {
  return { decision: "defer", context: payload, reason };
}
