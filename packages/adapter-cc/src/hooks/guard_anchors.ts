/**
 * Claude Code binding: Stop → guard_anchors
 *
 * CC Stop payload 基本为空 ({ cwd } 或更少)。翻译为 HookInput (event=Stop, cwd),
 * 调 handle, 翻译输出。
 *
 * CC 命令: node .claude/hooks/loop_engineering/guard_anchors.mjs
 */

import { handleGuardAnchors } from "@e2e-loop/shared";
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
    event: coerceEvent(payload.hook_event_name ?? "Stop"),
    cwd,
  };
  await runBinding(payload, () => input, handleGuardAnchors);
}

main().catch(() => {
  process.stdout.write("");
});
