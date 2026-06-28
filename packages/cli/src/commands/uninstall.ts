/**
 * e2e-loop uninstall 子命令。
 *
 * 用法:
 *   e2e-loop uninstall --host <cc|oc> --project-dir <path>
 *
 * 行为:
 *   - host=cc: 调 claudeCodeAdapter.uninstall(projectDir)
 *   - host=oc: stderr 提示 "P2", exit 1
 *   - 注意: host=both 不适用于 uninstall (一次只能卸一个 adapter 的产物)。
 */

import type { Args } from "../args.js";
import { claudeCodeAdapter } from "@e2e-loop/adapter-claude-code";
import {
  resolveProjectDir,
  OcNotImplementedError,
} from "../util.js";

export async function runUninstall(args: Args): Promise<number> {
  const host = args.values.host;
  if (!host) {
    process.stderr.write("错误: 缺少必需参数 --host <cc|oc>\n");
    return 1;
  }
  if (host !== "cc" && host !== "oc") {
    process.stderr.write(
      `错误: uninstall 的 --host 只接受 cc | oc, 收到: ${host}\n`,
    );
    return 1;
  }

  const projectDir = resolveProjectDir(args.values["project-dir"]);

  if (host === "oc") {
    throw new OcNotImplementedError(
      "OC adapter 在 P2 阶段实现 (host=oc 暂不可用)",
    );
  }

  // uninstall 是可选方法, 但 claudeCodeAdapter 实现了
  const uninstallFn = claudeCodeAdapter.uninstall;
  if (!uninstallFn) {
    process.stderr.write("错误: 当前 adapter 未实现 uninstall\n");
    return 1;
  }
  const result = await uninstallFn.call(claudeCodeAdapter, projectDir);
  process.stdout.write(
    `uninstall 完成: removed ${result.removedFiles.length}, notFound ${result.notFoundFiles.length}\n`,
  );
  for (const f of result.removedFiles) {
    process.stdout.write(`  - ${f}\n`);
  }
  for (const f of result.notFoundFiles) {
    process.stdout.write(`  ? ${f} (本就不存在)\n`);
  }
  return 0;
}
