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
  switch (name) {
    case "probe_and_gate":
      return {
        event: coerceEvent(payload.hook_event_name ?? "SessionStart"),
        cwd,
      };
    case "guard_paths":
      return {
        event: coerceEvent(payload.hook_event_name ?? "PreToolUse"),
        toolName: payload.tool_name,
        toolInput: payload.tool_input ?? {},
        cwd,
      };
    case "post_task_collect":
      return {
        event: coerceEvent(payload.hook_event_name ?? "PostToolUse"),
        toolName: payload.tool_name,
        toolInput: payload.tool_input ?? {},
        toolResponse: payload.tool_response ?? {},
        cwd,
      };
    case "guard_anchors":
      return {
        event: coerceEvent(payload.hook_event_name ?? "Stop"),
        cwd,
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

export async function runClaudeHook(rawName: string | undefined): Promise<number> {
  const name = normalizeCliHookName(rawName);
  if (!name) {
    process.stderr.write(`错误: 未知 hook "${rawName ?? ""}"\n`);
    return 1;
  }
  const payload = parseStdin(readStdin());
  const input = buildInput(name, payload);
  await runBinding(payload, () => input, handlerFor(name));
  return 0;
}
