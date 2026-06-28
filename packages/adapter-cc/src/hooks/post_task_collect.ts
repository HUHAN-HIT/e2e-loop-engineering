/** Claude Code binding: PostToolUse:Task -> post_task_collect. */

import { runClaudeHook } from "../hook_dispatcher.js";

runClaudeHook("post_task_collect").catch(() => {
  process.stdout.write("");
});
