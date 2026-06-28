/**
 * e2e-loop uninstall 子命令。
 *
 * 用法:
 *   e2e-loop uninstall --host <cc|oc|both> --project-dir <path>
 *
 * 行为:
 *   - host=cc:   调 claudeCodeAdapter.uninstall(projectDir)
 *   - host=oc:   调 opencodeAdapter.uninstall(projectDir)
 *   - host=both: 依次 uninstall 两个 adapter, 输出按宿主分段标注。
 *
 * both 模式说明: 两宿主共享的 `.claude/skills/loop-engineering/` 由先跑的 adapter 删除,
 * 后跑的 adapter 会把它报进 notFoundFiles——这是【预期】, 不算错。
 */

import type { Args } from "../args.js";
import type { HostAdapter } from "@e2e-loop/shared";
import { claudeCodeAdapter } from "@e2e-loop/adapter-claude-code";
import { opencodeAdapter } from "@e2e-loop/adapter-opencode";
import { resolveProjectDir } from "../util.js";

/** 跑单个 adapter 的 uninstall 并把结果写到 stdout (host=both 时带宿主标签前缀)。返回是否成功。 */
async function uninstallOne(
  adapter: HostAdapter,
  projectDir: string,
  label: string | null,
): Promise<boolean> {
  const tag = label ? `[${label}] ` : "";
  const uninstallFn = adapter.uninstall;
  if (!uninstallFn) {
    process.stderr.write(`${tag}错误: 当前 adapter 未实现 uninstall\n`);
    return false;
  }
  const result = await uninstallFn.call(adapter, projectDir);
  process.stdout.write(
    `${tag}uninstall 完成: removed ${result.removedFiles.length}, notFound ${result.notFoundFiles.length}\n`,
  );
  for (const f of result.removedFiles) {
    process.stdout.write(`  ${tag}- ${f}\n`);
  }
  for (const f of result.notFoundFiles) {
    process.stdout.write(`  ${tag}? ${f} (本就不存在)\n`);
  }
  return true;
}

export async function runUninstall(args: Args): Promise<number> {
  const host = args.values.host;
  if (!host) {
    process.stderr.write("错误: 缺少必需参数 --host <cc|oc|both>\n");
    return 1;
  }
  if (host !== "cc" && host !== "oc" && host !== "both") {
    process.stderr.write(
      `错误: uninstall 的 --host 只接受 cc | oc | both, 收到: ${host}\n`,
    );
    return 1;
  }

  const projectDir = resolveProjectDir(args.values["project-dir"]);

  // host=both: 依次 uninstall CC → OC, 输出按宿主分段。
  if (host === "both") {
    const okCc = await uninstallOne(claudeCodeAdapter, projectDir, "cc");
    process.stdout.write("\n");
    const okOc = await uninstallOne(opencodeAdapter, projectDir, "oc");
    return okCc && okOc ? 0 : 1;
  }

  // host=cc / oc: 单 adapter, 不带宿主标签。
  const adapter = host === "cc" ? claudeCodeAdapter : opencodeAdapter;
  const ok = await uninstallOne(adapter, projectDir, null);
  return ok ? 0 : 1;
}
