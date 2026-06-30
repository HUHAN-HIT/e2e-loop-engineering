import {
  handleGuardAnchors,
  handleGuardPaths,
  handlePostTaskCollect,
  handleProbeAndGate,
  type HookInput,
  type HookName,
  type HookOutput,
} from "@e2e-loop/shared";
import {
  buildCaller,
  coerceEvent,
  parseStdin,
  readStdin,
  runBinding,
  type CCPayload,
} from "./runtime.js";

export type CliHookName = HookName | DashHookName;

type DashHookName =
  | "probe-and-gate"
  | "guard-paths"
  | "post-task-collect"
  | "guard-anchors";

const HOOK_ALIASES: Record<string, HookName> = {
  "probe-and-gate": "probe_and_gate",
  probe_and_gate: "probe_and_gate",
  "guard-paths": "guard_paths",
  guard_paths: "guard_paths",
  "post-task-collect": "post_task_collect",
  post_task_collect: "post_task_collect",
  "guard-anchors": "guard_anchors",
  guard_anchors: "guard_anchors",
};

export function normalizeCliHookName(raw: string | undefined): HookName | null {
  if (!raw) return null;
  return HOOK_ALIASES[raw] ?? null;
}

export function toDashHookName(name: HookName): DashHookName {
  return name.replaceAll("_", "-") as DashHookName;
}

function buildInput(name: HookName, payload: CCPayload): HookInput {
  const cwd = payload.cwd ?? process.cwd();
  // caller 对所有 hook 一并翻译 (B 案 guard_paths 用; 其它 hook 字段就位但暂不消费).
  // SessionStart/Stop 在主 agent 触发, agent_id 缺失, buildCaller 自然返回 "main".
  const caller = buildCaller(payload);
  switch (name) {
    case "probe_and_gate":
      return {
        event: coerceEvent(payload.hook_event_name ?? "SessionStart"),
        cwd,
        caller,
      };
    case "guard_paths":
      return {
        event: coerceEvent(payload.hook_event_name ?? "PreToolUse"),
        toolName: payload.tool_name,
        toolInput: payload.tool_input ?? {},
        cwd,
        caller,
      };
    case "post_task_collect":
      return {
        event: coerceEvent(payload.hook_event_name ?? "PostToolUse"),
        toolName: payload.tool_name,
        toolInput: payload.tool_input ?? {},
        toolResponse: payload.tool_response ?? {},
        cwd,
        caller,
      };
    case "guard_anchors":
      return {
        event: coerceEvent(payload.hook_event_name ?? "Stop"),
        cwd,
        caller,
      };
  }
}

function handlerFor(
  name: HookName,
): (input: HookInput) => Promise<HookOutput> {
  switch (name) {
    case "probe_and_gate":
      return handleProbeAndGate;
    case "guard_paths":
      return handleGuardPaths;
    case "post_task_collect":
      return handlePostTaskCollect;
    case "guard_anchors":
      return handleGuardAnchors;
  }
}

/**
 * 各 hook 的 fail-safe 策略 (与 shared/src/hooks 下各 logic.ts 头部声明对齐)。
 *
 * probe_and_gate: 退化放行 - 不锁死 SessionStart, 让用户能进会话修复问题。
 * guard_paths / post_task_collect / guard_anchors: fail-safe=deny - 防糊弄护栏
 *   在 binding 层异常时也不能放过 (Python main except 分支语义, 设计 §0.2 / §0.4)。
 */
const FAIL_SAFE: Record<HookName, "allow" | "deny"> = {
  probe_and_gate: "allow",
  guard_paths: "deny",
  post_task_collect: "deny",
  guard_anchors: "deny",
};

export async function runClaudeHook(rawName: string | undefined): Promise<number> {
  const name = normalizeCliHookName(rawName);
  if (!name) {
    process.stderr.write(`错误: 未知 hook "${rawName ?? ""}"\n`);
    return 1;
  }
  const payload = parseStdin(readStdin());
  const input = buildInput(name, payload);
  await runBinding(payload, () => input, handlerFor(name), FAIL_SAFE[name]);
  return 0;
}
