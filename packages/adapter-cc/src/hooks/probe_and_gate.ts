/** Claude Code binding: SessionStart -> probe_and_gate. */

import { runClaudeHook } from "../hook_dispatcher.js";

runClaudeHook("probe_and_gate").catch(() => {
  process.stdout.write("");
});
