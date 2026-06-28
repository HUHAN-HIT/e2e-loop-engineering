/**
 * CLI 共享工具。
 *
 * - resolveProjectDir: 解析 --project-dir, 缺省 process.cwd()
 * - loadAdapter: 按 host 标识返回对应 HostAdapter; oc/both 在 P1 阶段显式失败
 *
 * 设计意图: 让 commands/*.ts 只关心参数解析与结果输出, adapter 选择与路径解析集中此处。
 */

import * as path from "node:path";
import { claudeCodeAdapter } from "@e2e-loop/adapter-claude-code";
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
 * - "oc" / "opencode": P2 阶段实现, 此处显式抛错 (协作范式红线: 不隐式降级)
 * - 其它: 抛 InvalidHost 错误
 *
 * 注意: host=both 的语义由 commands/install.ts 在调用前自行处理 (要协调两个 adapter),
 * 不走本函数。
 */
export function loadAdapter(host: string): HostAdapter {
  switch (host) {
    case "cc":
    case "claude-code":
      return claudeCodeAdapter;
    case "oc":
    case "opencode":
      // 协作范式红线: 显式失败而非隐式降级
      throw new OcNotImplementedError(
        "OC adapter 在 P2 阶段实现 (host=oc 暂不可用)",
      );
    default:
      throw new InvalidHostError(
        `未知 host: ${host} (合法值: cc | oc)`,
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

/** host=oc 在 P1 阶段未实现。 */
export class OcNotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OcNotImplementedError";
  }
}

/** both 模式在 P2 完成前不可用。 */
export class BothNotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BothNotImplementedError";
  }
}
