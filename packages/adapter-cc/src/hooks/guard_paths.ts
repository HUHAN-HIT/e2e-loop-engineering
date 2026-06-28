/** Claude Code binding: PreToolUse:Write|Edit -> guard_paths. */

import { runClaudeHook } from "../hook_dispatcher.js";

runClaudeHook("guard_paths").catch(() => {
  process.stdout.write("");
});
