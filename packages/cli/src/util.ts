/**
 * CLI 共享工具。
 *
 * - resolveProjectDir: 解析 --project-dir, 缺省 process.cwd()
 * - loadAdapter: 按 host 标识返回对应 HostAdapter (cc → CC, oc → OC)
 *
 * 设计意图: 让 commands/*.ts 只关心参数解析与结果输出, adapter 选择与路径解析集中此处。
 *
 * P2-B 起 host=oc 已接通 opencodeAdapter; host=both 由 commands 层协调两个 adapter,
 * 不走本函数 (见 commands/install.ts / uninstall.ts)。
 */

import * as path from "node:path";
import { claudeCodeAdapter } from "@e2e-loop/adapter-claude-code";
import { opencodeAdapter } from "@e2e-loop/adapter-opencode";
import type { HostAdapter } from "@e2e-loop/shared";

/** 解析 --project-dir 参数, 缺省回退到 process.cwd()。返回绝对路径。 */
export function resolveProjectDir(arg: string | undefined): string {
  const dir = arg && arg.length > 0 ? arg : process.cwd();
  return path.resolve(dir);
}

/**
 * 按 host 标识装载 adapter。
 *
 * - "cc" / "claude-code": 返回 claudeCodeAdapter
 * - "oc" / "opencode": 返回 opencodeAdapter (P2-B 接通)
 * - 其它: 抛 InvalidHost 错误
 *
 * 注意: host=both 的语义由 commands/install.ts / uninstall.ts 在调用前自行处理
 * (要协调两个 adapter), 不走本函数。
 */
export function loadAdapter(host: string): HostAdapter {
  switch (host) {
    case "cc":
    case "claude-code":
      return claudeCodeAdapter;
    case "oc":
    case "opencode":
      return opencodeAdapter;
    default:
      throw new InvalidHostError(
        `未知 host: ${host} (合法值: cc | oc | both)`,
      );
  }
}

/** --host 参数非法 (非 cc/oc/both)。 */
export class InvalidHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidHostError";
  }
}
