/**
 * Worktree 根 marker + loop hook 判据 (spec: 2026-06-29-worktree-only-isolation-design 改动①)。
 *
 * 这里是 shared 侧的"宿主无关"部分:
 * - marker 常量 / 类型 / 读 helper (`readWorktreeMarker` / `isInLoopWorktree`): 轻量手写校验,
 *   不引 zod (shared 现有无 zod 风格, 仅依赖 js-yaml)。marker 的"写"在 ssot-ts 侧 (走 atomicReplace)。
 * - loop hook 判据 (`isLoopHookCommand`) + settings 过滤纯函数 (`keepOnlyLoopHooks`): allocator
 *   把主工程 settings 过滤成"只含 loop hook"再写进 worktree, 实现 worktree 隔离。判据与
 *   adapter-cc/install.ts 的 isLoopEngineeringHookCommand 等价 (此处独立重实现, 不反向 import
 *   adapter)。
 *
 * marker 是"当前是否在 loop worktree 内"的唯一判据来源 (CLI enforcement 与 hook 正向自检都读它)。
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** marker 相对 worktree 根的路径。 */
export const WORKTREE_MARKER_REL = ".loop-engineering/worktree.json";
/** marker schema 版本标识。 */
export const WORKTREE_MARKER_SCHEMA = "loop-engineering.worktree-marker.v1";
/** marker owner (拒绝非本工具写的 marker)。 */
export const WORKTREE_MARKER_OWNER = "loop-engineering";

/** worktree 根 marker 数据形状。 */
export interface WorktreeMarker {
  /** 固定为 WORKTREE_MARKER_SCHEMA。 */
  readonly schema: string;
  /** 固定为 WORKTREE_MARKER_OWNER。 */
  readonly owner: string;
  /** 绑定的 run_id。 */
  readonly run_id: string;
  /** 创建时刻 ISO 8601。 */
  readonly created_at: string;
}

/**
 * 读 `<worktreeRoot>/.loop-engineering/worktree.json` 并轻量校验。
 *
 * 任何异常路径都返回 null (不抛): 文件不存在 / 读失败 / JSON 解析失败 / 顶层非对象 /
 * schema 不符 / owner 不符 / 缺 run_id / 缺 created_at。
 *
 * 不引 zod —— 与 shared 现有 runs.ts 的"手写守卫 + 返回 null"风格一致。
 */
export function readWorktreeMarker(worktreeRoot: string): WorktreeMarker | null {
  const markerPath = path.join(worktreeRoot, WORKTREE_MARKER_REL);
  let text: string;
  try {
    text = fs.readFileSync(markerPath, "utf-8");
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;
  if (obj.schema !== WORKTREE_MARKER_SCHEMA) return null;
  if (obj.owner !== WORKTREE_MARKER_OWNER) return null;
  if (typeof obj.run_id !== "string" || obj.run_id.length === 0) return null;
  if (typeof obj.created_at !== "string" || obj.created_at.length === 0) return null;
  return {
    schema: obj.schema,
    owner: obj.owner,
    run_id: obj.run_id,
    created_at: obj.created_at,
  };
}

/** cwd 下有合法 loop worktree marker 即 true。 */
export function isInLoopWorktree(cwd: string): boolean {
  return readWorktreeMarker(cwd) !== null;
}

// ---------------------------------------------------------------------------
// loop hook 判据 + settings 过滤
//
// 与 adapter-cc/install.ts 的 isLoopEngineeringHookCommand 等价但独立重实现 (架构红线:
// shared 不反向 import adapter)。两种形态都算 loop hook:
//   1. local .mjs 模式: command 含 `.claude/hooks/loop_engineering/<name>.mjs` 相对路径
//      (统一用 `loop_engineering` 子串判定, 与现有 allocator 一致)。
//   2. CLI 模式: 形如 `e2e-loop hook <name>` (name ∈ 4 个 dash 命名 hook)。
// ---------------------------------------------------------------------------

/** CLI hook 模式判据: `(^|\s)e2e-loop\s+hook\s+(probe-and-gate|guard-paths|post-task-collect|guard-anchors)`。 */
const LOOP_ENGINEERING_CLI_HOOK_RE =
  /(^|\s)e2e-loop\s+hook\s+(probe-and-gate|guard-paths|post-task-collect|guard-anchors)(\s|$)/;

/** 判定一条 hook command 是否属于 loop engineering (local .mjs 路径 或 CLI 模式)。 */
export function isLoopHookCommand(command: string): boolean {
  const normalized = command.replaceAll("\\", "/");
  // local .mjs 模式: 含 loop_engineering 子串 (与 allocator collectHookCommands 判定一致)
  if (normalized.includes("loop_engineering")) return true;
  // CLI 模式: e2e-loop hook <name>
  return LOOP_ENGINEERING_CLI_HOOK_RE.test(normalized);
}

/**
 * 把 settings 深拷贝后, 在每个事件的 hooks 里只保留 command 命中 loop 判据的条目。
 *
 * - 空了的 matcher (hooks 数组清空) 整条删掉;
 * - 空了的事件 (无 matcher 剩余) 整个事件键删掉;
 * - hooks 顶层若整个空了, 删掉 hooks 字段;
 * - 非 hooks 字段 (permissions / env 等) 原样保留;
 * - 形状不符 (hooks 非对象 / matcher 非数组 等) 时保守处理 (按"无 loop hook"处理该层)。
 *
 * 纯函数: 不改入参 (深拷贝后操作)。
 */
export function keepOnlyLoopHooks<T>(settings: T): T {
  if (typeof settings !== "object" || settings === null) return settings;
  const cloned = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>;
  const hooks = cloned.hooks;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    // 没有合法 hooks 结构 → 直接删掉 hooks (无 loop hook 可留), 其它字段原样保留。
    if ("hooks" in cloned) delete cloned.hooks;
    return cloned as unknown as T;
  }
  const hooksObj = hooks as Record<string, unknown>;
  const nextHooks: Record<string, unknown> = {};
  for (const [event, matchers] of Object.entries(hooksObj)) {
    if (!Array.isArray(matchers)) continue; // 形状不符, 丢弃该事件
    const keptMatchers: unknown[] = [];
    for (const matcher of matchers) {
      if (typeof matcher !== "object" || matcher === null) continue;
      const m = matcher as Record<string, unknown>;
      const inner = m.hooks;
      if (!Array.isArray(inner)) continue;
      const keptInner = inner.filter((entry) => {
        if (typeof entry !== "object" || entry === null) return false;
        const command = (entry as Record<string, unknown>).command;
        return typeof command === "string" && isLoopHookCommand(command);
      });
      if (keptInner.length > 0) {
        keptMatchers.push({ ...m, hooks: keptInner });
      }
    }
    if (keptMatchers.length > 0) {
      nextHooks[event] = keptMatchers;
    }
  }
  if (Object.keys(nextHooks).length > 0) {
    cloned.hooks = nextHooks;
  } else {
    delete cloned.hooks;
  }
  return cloned as unknown as T;
}
