/** Claude Code binding: Stop -> guard_anchors. */

import { runClaudeHook } from "../hook_dispatcher.js";

runClaudeHook("guard_anchors").catch(() => {
  process.stdout.write("");
});
