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
  /** --ac 多值收集 (amend 子命令用; 其它命令为空列表)。 */
  acList: string[];
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
  //
  // install/uninstall/list (P1~P3): host / project-dir / force / dry-run。
  // dry-run 子命令 (P5-M7B): runs-root / complexity / design / task-plan / max-ticks /
  //   reason / feedback (值参数), reject (开关), ac (多值, 收集成 acList)。
  // P5-M7C 新增真实 run 命令 (dispatch / collect-outcome) 用 --task 单值参数。
  const options = {
    host: { type: "string" as const },
    "project-dir": { type: "string" as const },
    force: { type: "boolean" as const },
    "dry-run": { type: "boolean" as const },
    "hook-mode": { type: "string" as const },
    "cli-command": { type: "string" as const },
    help: { type: "boolean" as const },
    h: { type: "boolean" as const },
    json: { type: "boolean" as const },
    doc: { type: "string" as const },
    // --- dry-run 子命令 ---
    "runs-root": { type: "string" as const },
    complexity: { type: "string" as const },
    design: { type: "string" as const },
    "task-plan": { type: "string" as const },
    "max-ticks": { type: "string" as const },
    "worktree-mode": { type: "string" as const },
    "worktree-root": { type: "string" as const },
    "worktree-path": { type: "string" as const },
    "branch-prefix": { type: "string" as const },
    base: { type: "string" as const },
    reason: { type: "string" as const },
    feedback: { type: "string" as const },
    reject: { type: "boolean" as const },
    // --ac 可多次出现, 收集为列表 (amend 触及的 AC ids)。
    ac: { type: "string" as const, multiple: true as const },
    // --- 真实 run 子命令 (M7C) ---
    // --task <id>: collect-outcome 必需, 指定要校验的 task_id
    task: { type: "string" as const },
    // --- clarification 子命令 ---
    // --answers <json-file>: answer-clarification 必需, 指向用户答案 JSON 文件
    answers: { type: "string" as const },
  };

  const values: Record<string, string | undefined> = {};
  const flags = new Set<string>();
  const positional: string[] = [];
  const acList: string[] = [];

  try {
    const parsed = parseArgs({
      args: rest,
      options,
      allowPositionals: true,
      strict: false,
    });
    for (const [k, v] of Object.entries(parsed.values)) {
      if (Array.isArray(v)) {
        // multiple:true 的选项 (目前仅 --ac) → 收集到 acList; 末值同时落 values 兜底。
        if (k === "ac") {
          acList.push(...v.filter((x): x is string => typeof x === "string"));
        }
        const last = v[v.length - 1];
        if (typeof last === "string") values[k] = last;
      } else if (typeof v === "string") {
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

  return { command, values, flags, positional, acList };
}

/** 参数解析错误。 */
export class ArgParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgParseError";
  }
}
