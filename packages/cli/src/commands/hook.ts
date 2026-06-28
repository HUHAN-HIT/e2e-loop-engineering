import type { Args } from "../args.js";
import { runClaudeHook } from "@e2e-loop/adapter-claude-code";

export async function runHook(args: Args): Promise<number> {
  const [hookName, extra] = args.positional;
  if (!hookName) {
    process.stderr.write("错误: 缺少 hook 名称。用法: e2e-loop hook <hook-name>\n");
    return 1;
  }
  if (extra) {
    process.stderr.write("错误: hook 命令不接受宿主参数。用法: e2e-loop hook <hook-name>\n");
    return 1;
  }
  return await runClaudeHook(hookName);
}
