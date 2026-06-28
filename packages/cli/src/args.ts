/**
 * 极简参数解析 (util.parseArgs 包装)。
 *
 * 把 process.argv.slice(2) 解析为:
 *   - command: 子命令名 (第一个非 -- 的 token), 如 "install"
 *   - values: Record<string, string>   ← --key value 形式的值参数
 *   - flags:  Set<string>              ← --flag 形式的开关参数
 *   - positional: string[]             ← 不带 -- 的位置参数 (除 command 外)
 *
 * 设计原则:
 *   - 不引第三方 (用 Node 20+ 内置 util.parseArgs)
 *   - 不做语义校验 (那个交给 commands/*.ts)
 *   - strict=false 容许未知选项, 让上层自行判断
 */

import { parseArgs } from "node:util";

export interface Args {
  command: string | undefined;
  values: Record<string, string | undefined>;
  flags: Set<string>;
  positional: string[];
}

/**
 * 解析 argv (不含 node 与脚本路径, 即 process.argv.slice(2))。
 *
 * 两段式:
 *   - 第一段: split out command (第一个非 -- 的 token)
 *   - 第二段: 用 util.parseArgs 解析剩余, options 内联
 */
export function parseCliArgs(tokens: string[]): Args {
  // 第一阶段: 找出 command
  let command: string | undefined;
  const rest: string[] = [];
  for (const t of tokens) {
    if (command === undefined && !t.startsWith("-")) {
      command = t;
    } else {
      rest.push(t);
    }
  }

  // 第二阶段: 解析剩余为 values + flags
  // option 形状: { type: "string" | "boolean", multiple?: boolean, short?: string }
  const options = {
    host: { type: "string" as const },
    "project-dir": { type: "string" as const },
    force: { type: "boolean" as const },
    "dry-run": { type: "boolean" as const },
    help: { type: "boolean" as const },
    h: { type: "boolean" as const },
  };

  const values: Record<string, string | undefined> = {};
  const flags = new Set<string>();
  const positional: string[] = [];

  try {
    const parsed = parseArgs({
      args: rest,
      options,
      allowPositionals: true,
      strict: false,
    });
    for (const [k, v] of Object.entries(parsed.values)) {
      if (typeof v === "string") {
        values[k] = v;
      } else if (v === true) {
        flags.add(k);
      }
    }
    if (parsed.positionals) {
      positional.push(...parsed.positionals);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ArgParseError(`参数解析失败: ${msg}`);
  }

  return { command, values, flags, positional };
}

/** 参数解析错误。 */
export class ArgParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgParseError";
  }
}
