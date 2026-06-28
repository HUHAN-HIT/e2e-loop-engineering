/**
 * Claude Code binding: SessionStart → probe_and_gate
 *
 * CC SessionStart payload 字段: { session_id, cwd, transcript_path, hook_event_name }。
 * 翻译为 HookInput (event=SessionStart, cwd), 调 shared.hooks.handle, 翻译输出。
 *
 * CC 命令: node .claude/hooks/loop_engineering/probe_and_gate.mjs
 */

import { handleProbeAndGate } from "@e2e-loop/shared";
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
    event: coerceEvent(payload.hook_event_name ?? "SessionStart"),
    cwd,
  };
  await runBinding(payload, () => input, handleProbeAndGate);
}

main().catch(() => {
  // 最外层兜底: 静默放行
  process.stdout.write("");
});
