/**
 * actual_writes 反馈环 (规范源: design §3.4; 行为权威: Python `scheduling/actual_writes.py`)。
 *
 * 三层采集优先级 (§3.4):
 *   1. git diff (authoritative): `git diff --name-only --diff-filter=ADMR <base>` +
 *      `git status --porcelain` 合并 (单 diff 抓不到 untracked, 故双管齐下)。
 *   2. fs snapshot (authoritative): 对比 before/after 两个 `{path: mtime_ns}` 快照。
 *   3. worker self report (非 authoritative): 读 task 自己写的 summary.md / key-diffs.yaml。
 *
 * 诚实声明 (§3.4): 越界按"写过"判不按"最终内容"判 —— worker 先写再删的路径仍计入。
 * git 路径用 `--diff-filter=ADMR` + `status --porcelain` 抓全量; fs 路径用 mtime_ns 对比,
 * 删除的路径 (before 有 after 无) 也算"被写过"。
 *
 * 越界检测两层 (§3.4):
 *   1. actual_writes 中有路径不在 task.allowed_write_paths 范围内 → 越界。
 *   2. actual_writes 中有路径已被更早 task 写过 → 越界 (跨 task 共享路径归最早写入者)。
 */

import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { matchPath } from "./path_match.js";

/** 采集来源 (§3.4) */
export type ActualWritesSource = "git" | "fs" | "self_report";

/**
 * actual_writes 采集结果。
 *
 * `isAuthoritative=true` 表示由 coordinator 侧独立采集 (git/fs), 数据不经 worker;
 * `false` 表示回退 worker 自报告, 第 2 层防线退化为软约束 (§3.4)。
 */
export interface ActualWrites {
  source: ActualWritesSource;
  paths: string[];
  isAuthoritative: boolean;
}

/** 越界检测结果 (§3.4 两层) */
export interface BoundaryCheck {
  /** 不在 allowed_write_paths 范围内的路径 */
  outOfBounds: string[];
  /** 已被更早 task 写过的路径 (跨 task 共享归最早) */
  collided: string[];
}

// fs snapshot 排除的目录 / 后缀 (与 Python `_FS_EXCLUDE_DIRS` / `_FS_EXCLUDE_SUFFIXES` 一致),
// 避免噪音污染对比基线。
const FS_EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "__pycache__",
  "node_modules",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
]);
const FS_EXCLUDE_SUFFIXES: readonly string[] = [".pyc", ".pyo"];

/** fs snapshot 是否排除该相对路径 (按目录段 / 后缀)。 */
function shouldExcludeRelPath(rel: string): boolean {
  if (FS_EXCLUDE_SUFFIXES.some((s) => rel.endsWith(s))) return true;
  for (const seg of rel.split("/")) {
    if (FS_EXCLUDE_DIRS.has(seg)) return true;
  }
  return false;
}

/**
 * L1: git diff 采集 (authoritative)。
 *
 * 双管齐下抓全量变更文件 (§3.4 "写过判", 单 diff 抓不到 untracked):
 *   - `git -C <workdir> diff --name-only --diff-filter=ADMR <base>`: 已 add/delete/modify/rename
 *   - `git -C <workdir> status --porcelain`: untracked / staged / 工作树修改
 *
 * @param repoRoot git 仓库根 (workdir)
 * @param baseRef  git base ref (commit/stash/tree), 例如 "HEAD" 或 `git stash create` 返回值
 * @returns POSIX 相对路径列表; 非 git repo / bad ref / subprocess 异常返回 null
 *          (调用方必须降级, 不能把失败伪装成 authoritative empty diff)。
 */
export function tryGitDiff(repoRoot: string, baseRef: string): string[] | null {
  const writes = new Set<string>();
  const timeoutMs = 10_000;

  try {
    const diff = cp.execFileSync(
      "git",
      ["-C", repoRoot, "diff", "--name-only", "--diff-filter=ADMR", baseRef],
      { encoding: "utf-8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"] },
    );
    for (const line of diff.split(/\r?\n/)) {
      const t = line.trim();
      if (t) writes.add(t.replace(/\\/g, "/"));
    }
  } catch {
    // diff 失败 (非 repo / bad ref / 超时) → 整体降级
    return null;
  }

  try {
    const status = cp.execFileSync(
      "git",
      ["-C", repoRoot, "status", "--porcelain"],
      { encoding: "utf-8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"] },
    );
    for (const line of status.split(/\r?\n/)) {
      if (!line) continue;
      // porcelain: "XY path", XY 是两字符状态, 之后一个空格 + path; rename 形如 "XY a -> b"
      const payload = line.slice(3).trim().replace(/^"(.*)"$/, "$1");
      // 处理 rename: "a -> b" 取 b (rename 后的实际路径)
      const renamed = payload.includes(" -> ")
        ? payload.split(" -> ").pop()!.replace(/^"(.*)"$/, "$1")
        : payload;
      if (renamed) writes.add(renamed.replace(/\\/g, "/"));
    }
  } catch {
    // status 失败同样降级
    return null;
  }

  return Array.from(writes).sort();
}

/**
 * L2: fs snapshot 采集 (authoritative)。
 *
 * 读 `<runDir>/tasks/<taskId>/before.snapshot` 与 `after.snapshot`, 对比 mtime_ns 差异。
 * 两个文件必须都存在且为合法 JSON (Python 端写的是 `{path: mtime_ns_int}` dict);
 * 任一缺失/不可解析返回 null, 调用方降级到 self_report。
 *
 * snapshot 文件由 coordinator 在派发 task 前后写入 (Python `take_fs_snapshot` 产出);
 * 本函数只负责"读 + 对比", 不重新遍历文件系统 (那会丢失"写了又删"的信号, 与 Python 行为一致)。
 */
export function tryFsSnapshot(runDir: string, taskId: string): string[] | null {
  const base = path.join(runDir, "tasks", taskId);
  let before: Record<string, number>;
  let after: Record<string, number>;
  try {
    before = JSON.parse(
      fs.readFileSync(path.join(base, "before.snapshot"), "utf-8"),
    ) as Record<string, number>;
    after = JSON.parse(
      fs.readFileSync(path.join(base, "after.snapshot"), "utf-8"),
    ) as Record<string, number>;
  } catch {
    return null;
  }
  if (
    typeof before !== "object" || before === null ||
    typeof after !== "object" || after === null
  ) {
    return null;
  }

  const all = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const p of all) {
    if (before[p] !== after[p]) changed.push(p);
  }
  return changed.sort();
}

/**
 * 从 worker 自报告文本里粗抓文件路径 (与 Python `_extract_paths_from_text` 一致)。
 *
 * 只抓形如 `a/b.c` 或 `a\b.c` 的相对路径 (至少一个分隔符 + 后缀), 不抓绝对路径 / 单文件名。
 * 用于 self_report 兜底采集 (非 authoritative) 以及 post_task_collect 的不一致 warning。
 */
export function extractPathsFromText(text: string): Set<string> {
  const out = new Set<string>();
  const pat = /[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+\.[A-Za-z0-9]+/g;
  for (const m of (text || "").matchAll(pat)) {
    out.add(m[0].replace(/\\/g, "/"));
  }
  return out;
}

/**
 * L3: worker 自报告采集 (非 authoritative)。
 *
 * 从 `<runDir>/tasks/<taskId>/summary.md` + `key-diffs.yaml` 文本里粗抓文件路径。
 * 文件都不存在返回空数组 (调用方据此生成 warning "未抓到任何声明")。
 *
 * 注意: Python 端 post_task_collect 在 §0.2 防糊弄路径下其实把 self_report 从 worker
 * 的 toolResponse 文本里抽出来; 这里读 artifact 文件是因为 TS hook 不直接信任 toolResponse
 * 文本, 而是先要求 worker 把声明落盘到 summary/key-diffs。两条路径互补。
 */
export function readSelfReport(runDir: string, taskId: string): string[] {
  const base = path.join(runDir, "tasks", taskId);
  const collected = new Set<string>();

  for (const name of ["summary.md", "key-diffs.yaml"]) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(base, name), "utf-8");
    } catch {
      continue;
    }
    for (const p of extractPathsFromText(text)) collected.add(p);
  }

  return Array.from(collected).sort();
}

/**
 * 按 §3.4 三层优先级采集 actual_writes。
 *
 *   1. tryGitDiff(repoRoot, sinceMarker) → source="git", authoritative
 *   2. tryFsSnapshot(runDir, taskId)     → source="fs", authoritative
 *   3. readSelfReport(runDir, taskId)    → source="self_report", 非 authoritative
 *
 * `sinceMarker` 缺省时跳过 git, 直接走 fs / self_report。
 * 返回 Promise (签名要求), 内部用同步 API (git/fs), 实测耗时 < 100ms;
 * 不在 hot path 上阻塞 event loop 太久。
 */
export async function computeActualWrites(
  runDir: string,
  taskId: string,
  sinceMarker?: string,
  repoRoot?: string,
): Promise<ActualWrites> {
  // L1 git
  if (sinceMarker) {
    const root = repoRoot ?? path.resolve(runDir, "..", "..");
    const writes = tryGitDiff(root, sinceMarker);
    if (writes !== null) {
      return { source: "git", paths: writes, isAuthoritative: true };
    }
  }

  // L2 fs snapshot
  const fsWrites = tryFsSnapshot(runDir, taskId);
  if (fsWrites !== null) {
    return { source: "fs", paths: fsWrites, isAuthoritative: true };
  }

  // L3 self report (兜底, 非 authoritative)
  return {
    source: "self_report",
    paths: readSelfReport(runDir, taskId),
    isAuthoritative: false,
  };
}

/**
 * 越界检测 (§3.4 两层)。
 *
 *   1. actualPaths 中有路径不在 allowedWritePaths 任何 glob 内 → outOfBounds
 *   2. actualPaths 中有路径已在 earlierWrittenPaths 内 → collided
 *
 * path 重叠判定用 `matchPath` (path_match.ts) 与 Python `path_globs_overlap` 等价。
 * actualPaths 为空 → 不越界 (空数组), 不抛。
 */
export function checkBoundary(
  actualPaths: readonly string[],
  allowedWritePaths: readonly string[],
  earlierWrittenPaths: readonly string[],
): BoundaryCheck {
  const outOfBounds: string[] = [];
  const collided: string[] = [];
  const earlierSet = new Set(earlierWrittenPaths);

  for (const p of actualPaths) {
    // 层 1: path 不在 declared 范围内 → 越界
    // allowedWritePaths 为空 → 任何写入都越界
    const inDeclared = allowedWritePaths.some((glob) => matchPath(glob, p));
    if (!inDeclared) {
      outOfBounds.push(p);
      continue;
    }
    // 层 2: path 已被更早 task 写过 → 越界 (归最早写入者)
    if (earlierSet.has(p)) {
      collided.push(p);
    }
  }

  return { outOfBounds, collided };
}
