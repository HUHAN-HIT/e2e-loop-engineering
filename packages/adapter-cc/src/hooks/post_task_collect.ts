/**
 * Claude Code binding: PostToolUse:Task → post_task_collect
 *
 * CC PostToolUse payload 字段:
 *   { tool_name, tool_input: { subagent_type, prompt }, tool_response: {...}, cwd }
 * 翻译为 HookInput (event=PostToolUse, toolName, toolInput, toolResponse, cwd),
 * 调 handle, 翻译输出 + 落 sideEffect (actual-writes.json 等)。
 *
 * CC 命令: node .claude/hooks/loop_engineering/post_task_collect.mjs
 */

import { handlePostTaskCollect } from "@e2e-loop/shared";
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
    event: coerceEvent(payload.hook_event_name ?? "PostToolUse"),
    toolName: payload.tool_name,
    toolInput: payload.tool_input ?? {},
    toolResponse: payload.tool_response ?? {},
    cwd,
  };
  await runBinding(payload, () => input, handlePostTaskCollect);
}

main().catch(() => {
  process.stdout.write("");
});
