/**
 * OpenCode plugin binding 公共运行时。
 *
 * OpenCode 的 plugin 是跑在 Bun 里的 ES 模块, 通过导出 hooks 对象接入宿主事件:
 *   - tool.execute.before(input, output): 工具执行前; throw 即拦截该工具。
 *   - tool.execute.after(input, output):  工具执行后 (非阻断)。
 *   - event({event}):                     会话级通知 (非阻断, 不能 throw 阻止回合)。
 *
 * 本模块封装 OC binding 的"HookOutput → OC 动作"翻译 + 副作用落盘 + 退化放行包装,
 * 让 plugin 入口 (index.ts) 只需各自做 HookInput 翻译 + 调 shared 的 handle*。
 *
 * 与 adapter-cc/runtime.ts 的对应:
 *   - CC 用 stdin/stdout JSON; OC 用 throw/log + 直接落盘。
 *   - applySideEffect 落盘逻辑思路一致 (node:fs), 但 OC 不经 stdout, 直接写。
 *
 * 协议要点 (HookOutput.decision):
 *   - allow → 不做任何事 (放行)。
 *   - deny  → tool.execute.before 里 throw new Error(reason) 拦截; 其它事件只能记录。
 *   - defer → 放行 + 把 context 当"劝告/通知"记录 (OC 无下一轮提示词注入的等价物, 这是已知差异 R9)。
 *
 * 退化放行 (safeRun): plugin 不应因内部错误锁死会话。任何 handle 内部异常都吞掉放行,
 * 唯一例外是 guard_paths 的**有意 deny** —— 它必须 throw 出去才能拦截工具, 不能被吞。
 * 因此 safeRun 只兜底"内部错误", 而 deny 的 throw 由调用方在 catch 之外单独发起。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { HookOutput, SideEffect } from "@e2e-loop/shared";

/**
 * 最小化的 OC plugin 类型 (只声明本 binding 实际用到的字段)。
 *
 * 不从 @opencode-ai/plugin import 运行时值 (该包仅类型), 自己写最小子集以便 bundle 后
 * 不带任何运行时依赖。字段名以 opencode.ai/docs/plugins 文档为准。
 */

/** plugin 入参的 client (用 app.log 做劝告式告警; 失败时回退 stderr)。 */
export interface OcClient {
  app?: {
    log?: (entry: {
      service?: string;
      level?: string;
      message?: string;
    }) => unknown;
  };
}

/** tool.execute.before / after 的第一参 (工具元信息)。 */
export interface OcToolInputMeta {
  /** 工具名 (OC 工具名小写: write / edit / read / bash / task)。 */
  tool?: string;
  sessionID?: string;
  callID?: string;
}

/** tool.execute.before 的第二参 (工具入参, before 阶段可读可改)。 */
export interface OcToolBeforeOutput {
  /** 工具入参: write/edit 的路径在 args.filePath, 内容在 args.content。 */
  args?: Record<string, unknown>;
}

/** tool.execute.after 的第二参 (工具结果)。 */
export interface OcToolAfterOutput {
  /** 工具返回标题 / 输出 / 元数据 (task 工具结束即子 agent 分发结束)。 */
  title?: string;
  output?: unknown;
  metadata?: unknown;
  args?: Record<string, unknown>;
}

/** event hook 的入参。 */
export interface OcEventArg {
  event?: {
    /** 事件类型: "session.idle" | "session.created" | ... */
    type?: string;
    properties?: Record<string, unknown>;
  };
}

/** plugin 工厂入参 (只取本 binding 用到的)。 */
export interface OcPluginContext {
  /** 项目根目录 (绝对路径); 当 HookInput.cwd 用。 */
  directory?: string;
  worktree?: string;
  client?: OcClient;
  // project / $ 等其它字段本 binding 不用, 略。
}

/** plugin 返回的 hooks 对象 (本 binding 实现的 3 个)。 */
export interface OcPluginHooks {
  "tool.execute.before"?: (
    input: OcToolInputMeta,
    output: OcToolBeforeOutput,
  ) => Promise<void> | void;
  "tool.execute.after"?: (
    input: OcToolInputMeta,
    output: OcToolAfterOutput,
  ) => Promise<void> | void;
  event?: (arg: OcEventArg) => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// HookOutput → OC 动作翻译
// ---------------------------------------------------------------------------

/**
 * deny → throw new Error(reason) 拦截工具; allow / defer → 不 throw (放行)。
 *
 * 仅用于 tool.execute.before (OC 唯一能阻断工具的钩子)。defer 在 before 阶段
 * 语义退化为放行 (guard_paths 不产 defer, 故不影响行为)。
 */
export function hookOutputToThrow(out: HookOutput): void {
  if (out.decision === "deny") {
    throw new Error(out.reason ?? "blocked by loop-engineering plugin");
  }
  // allow / defer: 不 throw, 放行。
}

/**
 * 把 HookOutput.sideEffect 落盘 (post_task_collect 的 actual-writes.json 等)。
 *
 * file 绝对路径直接用; 相对路径相对 baseDir 解析 (与 adapter-cc/runtime.ts applySideEffect 同思路)。
 * 落盘失败不抛 (副作用失败不应影响主流程), 返回 null。
 */
export function applySideEffect(
  out: HookOutput,
  baseDir: string,
): string | null {
  if (!out.sideEffect) return null;
  const se: SideEffect = out.sideEffect;
  const target = path.isAbsolute(se.file)
    ? se.file
    : path.resolve(baseDir, se.file);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const content =
      typeof se.content === "string"
        ? se.content
        : JSON.stringify(se.content, null, 2);
    fs.writeFileSync(target, content, "utf-8");
    return target;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 劝告式告警 (defer / after-deny / session.idle 用; 非阻断)
// ---------------------------------------------------------------------------

/**
 * 劝告式告警: 优先 client.app.log, 失败回退 stderr。
 *
 * 用于 OC 无法真正阻断的场景 (tool.execute.after 的 deny / event 的 deny|defer),
 * 这是已知差异 R9: OC 的 Stop 等价物 (session.idle) 是非阻断通知, 只能"劝告"。
 */
export function advise(
  client: OcClient | undefined,
  message: string,
): void {
  const logFn = client?.app?.log;
  if (typeof logFn === "function") {
    try {
      logFn({ service: "loop-engineering", level: "warn", message });
      return;
    } catch {
      // 回退 stderr
    }
  }
  try {
    process.stderr.write(`[loop-engineering plugin] ${message}\n`);
  } catch {
    /* noop */
  }
}

// ---------------------------------------------------------------------------
// 退化放行包装
// ---------------------------------------------------------------------------

/**
 * safeRun: 跑 fn, 内部异常退化放行 (吞掉 + stderr 提示)。
 *
 * 关键区分: guard_paths 的有意 deny 是通过 hookOutputToThrow 在 fn **之后**单独
 * throw 的 (见 index.ts 的 before 钩子), 不在 fn 内部; 故 safeRun 只兜底"读状态/落盘
 * 等内部错误", 不会误吞 deny 的拦截。
 *
 * @returns fn 的返回值; 异常时返回 undefined (放行)。
 */
export async function safeRun<T>(
  label: string,
  fn: () => Promise<T> | T,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    try {
      process.stderr.write(
        `[loop-engineering plugin] ${label} 内部错误, 退化放行: ${
          e instanceof Error ? e.message : String(e)
        }\n`,
      );
    } catch {
      /* noop */
    }
    return undefined;
  }
}
