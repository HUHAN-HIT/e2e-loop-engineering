/**
 * Claude Code binding: PreToolUse:Write|Edit → guard_paths
 *
 * CC PreToolUse payload 字段: { tool_name, tool_input: { file_path, content, ... }, cwd }。
 * 翻译为 HookInput (event=PreToolUse, toolName, toolInput, cwd), 调 handle, 翻译输出。
 *
 * CC 命令: node .claude/hooks/loop_engineering/guard_paths.mjs
 */

import { handleGuardPaths } from "@e2e-loop/shared";
import type { HookInput } from "@e2e-loop/shared";
import {
  coerceEvent,
  parseStdin,
  readStdin,
  runBinding,
} from "../runtime.js";

async function main(): Promise<void> {
  const payload = parseStdin(readStdin());
  const cwd = payload.cwd ?? process.cwd();
  const input: HookInput = {
    event: coerceEvent(payload.hook_event_name ?? "PreToolUse"),
    toolName: payload.tool_name,
    toolInput: payload.tool_input ?? {},
    cwd,
  };
  await runBinding(payload, () => input, handleGuardPaths);
}

main().catch(() => {
  process.stdout.write("");
});
