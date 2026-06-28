/**
 * Claude Code hook binding 公共运行时。
 *
 * CC 的 hook 通过 stdin 接收 JSON payload, 通过 stdout 返回决策对象。
 * 本模块封装"读 stdin / 翻译 HookOutput → CC stdout JSON / sideEffect 落盘"
 * 的公共逻辑, 让 4 个 binding 只需各自做 HookInput 翻译 + 调 handle。
 *
 * 协议要点 (行为权威: Python `hooks/loop_engineering/common.py`):
 *   - allow → stdout 空 (静默放行) 或 `{}`
 *   - deny  → `{"decision": "block", "reason": "..."}`
 *   - defer → `{"hookSpecificOutput": {"additionalContext": <JSON.stringify(context)>}}`
 *             (放行 + 下一轮提示词注入)
 *   - sideEffect → binding 层负责落盘 (fs.writeFileSync)
 *
 * fail-safe: binding 任何异常都 try/catch, 静默放行 (CC hook 不锁死会话)。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { HookEvent, HookInput, HookOutput } from "@e2e-loop/shared";

/** CC hook stdin payload (字段为各事件并集, binding 各取所需)。 */
export interface CCPayload {
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown> | null;
  tool_response?: Record<string, unknown> | null;
  /** Stop 事件有时带 stop_hook_active */
  stop_hook_active?: boolean;
  [k: string]: unknown;
}

/** 读 stdin 全部为字符串 (空 stdin 返回 "")。 */
export function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

/** 解析 stdin JSON, 空 / 解析失败返回 {}。 */
export function parseStdin(raw: string): CCPayload {
  if (!raw || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return typeof v === "object" && v !== null ? (v as CCPayload) : {};
  } catch {
    return {};
  }
}

/**
 * 把 HookEvent 字符串规范为 HookEvent 联合类型; 未知事件回退 "Stop" (CC 不会发出未知事件)。
 */
export function coerceEvent(name: string | undefined): HookEvent {
  switch (name) {
    case "SessionStart":
      return "SessionStart";
    case "PreToolUse":
      return "PreToolUse";
    case "PostToolUse":
      return "PostToolUse";
    case "Stop":
      return "Stop";
    case "UserPromptSubmit":
      return "UserPromptSubmit";
    default:
      return "Stop";
  }
}

/** 把 HookOutput 翻译为 CC stdout JSON 对象。allow → null (输出空)。 */
export function hookOutputToCCStdout(out: HookOutput): Record<string, unknown> | null {
  if (out.decision === "allow") return null;
  if (out.decision === "deny") {
    return { decision: "block", reason: out.reason ?? "blocked by loop-engineering hook" };
  }
  // defer: 注入 additionalContext (CC 期望 JSON 字符串)
  // CC 协议: hookSpecificOutput.additionalContext 字符串会被注入到下一轮提示词。
  // 参考 Python common.py additional_context() 的实现。
  const contextStr = JSON.stringify(out.context ?? {});
  const result: Record<string, unknown> = {
    hookSpecificOutput: { additionalContext: contextStr },
  };
  if (out.reason) result.reason = out.reason;
  return result;
}

/**
 * 把 HookOutput.sideEffect 落盘 (post_task_collect 的 actual-writes.json 等)。
 * file 路径相对 runDir 解析; 若 file 已是绝对路径则直接用。
 */
export function applySideEffect(out: HookOutput, baseDir: string): string | null {
  if (!out.sideEffect) return null;
  const se = out.sideEffect;
  const target = path.isAbsolute(se.file) ? se.file : path.resolve(baseDir, se.file);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const content =
      typeof se.content === "string" ? se.content : JSON.stringify(se.content, null, 2);
    fs.writeFileSync(target, content, "utf-8");
    return target;
  } catch {
    // sideEffect 落盘失败不阻塞决策 (已 emit 过的 stdout 不受影响)
    return null;
  }
}

/**
 * 输出 stdout JSON。allow 时输出空字符串 (CC 静默放行)。
 */
export function emitStdout(obj: Record<string, unknown> | null): void {
  if (obj === null) {
    // 空输出 = 放行
    process.stdout.write("");
    return;
  }
  process.stdout.write(JSON.stringify(obj));
}

/**
 * binding 主入口的标准调度:
 *   读 stdin → 调 buildInput(得到 HookInput) → handle → 翻译输出 → emit stdout
 *   异常一律退化放行 (emit 空 + stderr 提示)。
 */
export async function runBinding(
  payload: CCPayload,
  buildInput: (p: CCPayload) => HookInput,
  handle: (input: HookInput) => Promise<HookOutput>,
): Promise<void> {
  try {
    const input = buildInput(payload);
    const out = await handle(input);
    if (out.sideEffect && input.runDir) {
      applySideEffect(out, input.runDir);
    }
    emitStdout(hookOutputToCCStdout(out));
  } catch (e) {
    // CC hook fail-safe: 不锁死会话
    try {
      process.stderr.write(
        `[loop-engineering hook] 内部错误, 退化放行: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    } catch {
      /* noop */
    }
    emitStdout(null);
  }
}
