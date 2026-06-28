/**
 * 写路径重叠检测 (design §3.2 / §11.1)。
 *
 * 行为权威: Python `loop_engineering/scheduling/path_overlap.py`。
 * 规范源: design §3.2 —— "`path_globs_overlap` 无法静态判定时保守返回 True (默认串行)"。
 * 本算法是本方案唯一需要充分单测的硬正确性防线 (§3.2 原文)。
 *
 * 实现要点 (与 Python 等价):
 * - glob 基础匹配 (单 glob → 具体路径) 复用 `@e2e-loop/shared` 的 `matchPath`,
 *   不重复造一套 glob 引擎。
 * - `*` 不跨 `/`, 只有 `**` 跨 —— 与 §3.2 case 一致 (matchPath 已保证此语义)。
 * - 任何无法静态判定的语法 (含 `!`、`[` 字符类、`{` brace、`\` 转义) 一律保守 True。
 * - 目录缩写: 末尾无 `/` 的 glob 视为同时匹配自身或其下任意文件 (a ≡ a 或 a/**)。
 *
 * 重叠判定策略 (复刻 Python `_globs_overlap`):
 *   1. 派生代表性路径样本集, 对每个样本用 matchPath 双向匹配, 任一样本双方都命中 → True。
 *   2. 样本未覆盖时, 用结构化兜底 (`_structuralOverlap`) 处理 `**` / `prefix/**` / `*.ext`。
 *
 * 注意: 跨服务写冲突语义 (`conflicts` 的 service-aware 分支) 是 P1 时被标记缺失的部分,
 * 此处补齐 (§11.1 C2)。实际写入采集 (actual_writes) 不在本文件, 由 shared re-export。
 */
import { matchPath, normalizePath } from "@e2e-loop/shared";

import type { Task } from "../schema/task_plan.js";

/**
 * 判不准即保守: 凡包含这些"我们不打算精确解析"的语法, 一律视为重叠。
 * - `!` 前缀: gitignore 风格否定, design §3.2 未规定语义。
 * - `[` / `]`: 字符类, 与路径语义混合时易判错, 保守。
 * - `{` / `}`: brace 展开, 不支持。
 * - `\`: 转义, 在 path glob 中极少见且易错, 保守。
 *
 * 与 Python `_CONSERVATIVE_CHARS = frozenset("![]{}\\")` 一一对应。
 */
const CONSERVATIVE_CHARS: ReadonlySet<string> = new Set([
  "!",
  "[",
  "]",
  "{",
  "}",
  "\\",
]);

/** glob 含未明确支持的语法 → 判不准 (保守 True 的触发条件)。 */
function isUnparseable(glob: string): boolean {
  if (!glob) return true;
  for (const ch of glob) {
    if (CONSERVATIVE_CHARS.has(ch)) return true;
  }
  return false;
}

/**
 * 从两个 glob 派生代表性路径样本集, 用于重叠探测 (复刻 Python `_candidate_samples`)。
 *
 * 覆盖: glob 自身字面量段、单/多层级组合、末尾文件名变体。
 */
function candidateSamples(a: string, b: string): Set<string> {
  const samples = new Set<string>();

  const emitFrom = (g: string): void => {
    // 字面量子串 (剥离通配后保留的可读段)。
    let literal = g.replace(/\*+|\?/g, "");
    // strip("/"): 去掉首尾的 /
    literal = literal.replace(/^\/+/, "").replace(/\/+$/, "");
    if (literal) {
      samples.add(literal);
      // 加一层文件。
      samples.add(`${literal}/x.py`);
      samples.add(`${literal}/sub/x.py`);
      // 字面量作为末段文件名 (Python: 含 . 且无 / 时再 add 一次, set 去重等价)。
      if (!literal.includes("/") && literal.includes(".")) {
        samples.add(literal);
      }
    }
    // 单层文件名样本。
    for (const stem of ["x.py", "y.txt"]) {
      samples.add(stem);
      samples.add(`sub/${stem}`);
    }
  };

  emitFrom(a);
  emitFrom(b);
  return samples;
}

/**
 * 当样本探测未命中时的结构化兜底判定 (复刻 Python `_structural_overlap`)。
 *
 * 规则 (保守优先):
 * - 任一 glob 是 `**` (匹配任意) → True。
 * - 任一 glob 形如 `prefix/**` 且另一 glob 以相同 prefix 起头 → True。
 * - 否则 False。
 *
 * (Python 注释里提到 `*.ext` 同层规则, 但实际代码未实现该分支; 此处与代码行为对齐。)
 */
function structuralOverlap(a: string, b: string): boolean {
  // `**` 单独: 与任何东西都重叠。
  if (a === "**" || b === "**") return true;

  const prefixOf = (g: string): string | null =>
    g.endsWith("/**") ? g.slice(0, -3) : null;

  const pa = prefixOf(a);
  const pb = prefixOf(b);
  if (pa !== null && (b === pa || b.startsWith(`${pa}/`))) return true;
  if (pb !== null && (a === pb || a.startsWith(`${pb}/`))) return true;

  return false;
}

/**
 * 两个单 glob 是否重叠。判不准 → True (保守)。复刻 Python `_globs_overlap`。
 *
 * 用 matchPath 做"单 glob → 具体样本路径"的双向匹配; matchPath 已实现
 * `*` 不跨 `/` / `**` 跨 / 目录缩写前缀 等语义, 与 Python `_translate_glob` 等价。
 */
function globsOverlap(a: string, b: string): boolean {
  // 任一含未支持语法 → 保守 True (对齐 Python: ra/rb 任一为 None 即 True)。
  if (isUnparseable(a) || isUnparseable(b)) return true;

  const na = normalizePath(a);
  const nb = normalizePath(b);

  // 样本探测: 任一样本被双方都匹配 → 重叠。
  const samples = candidateSamples(na, nb);
  for (const s of samples) {
    if (matchPath(na, s) && matchPath(nb, s)) return true;
  }

  // 样本未覆盖到的潜在重叠: 结构化兜底。
  return structuralOverlap(na, nb);
}

/**
 * 两个 glob 列表之间是否存在任一 pair 重叠 (design §3.2)。
 *
 * 无法静态判定时保守返回 True (默认串行)。
 * 空列表视为"无写路径", 永不与任何东西重叠 (return false)。
 */
export function pathGlobsOverlap(
  globsA: readonly string[],
  globsB: readonly string[],
): boolean {
  if (globsA.length === 0 || globsB.length === 0) return false;
  for (const a of globsA) {
    for (const b of globsB) {
      if (globsOverlap(a, b)) return true;
    }
  }
  return false;
}

/**
 * 两个 task 是否写冲突 (design §3.2 + §11.1 C2 修复)。
 *
 * service-aware 语义 (这是 P1 时缺失、本里程碑补齐的部分):
 * - 跨服务 (两者 service 都非空且不同): 永不冲突 (§11.1 C2)。
 * - 任一 service 为空 (null/undefined): 视为同默认服务, 走同服务分支。
 * - 同服务: 任一 exclusive → 冲突 (独占本服务一批); 否则按写路径重叠判。
 */
export function conflicts(a: Task, b: Task): boolean {
  const sa = a.service ?? null;
  const sb = b.service ?? null;
  // 跨服务: 永不冲突 (§11.1 C2 修复)。
  if (sa !== null && sb !== null && sa !== sb) return false;
  // 同服务分支: 任一 exclusive 即独占本服务一批。
  if (a.exclusive || b.exclusive) return true;
  return pathGlobsOverlap(a.allowed_write_paths, b.allowed_write_paths);
}
