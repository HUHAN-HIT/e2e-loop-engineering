/**
 * harness 自身 bootstrap 产物的 canonical 路径集 + 判定 + gitignore 托管块读写。
 *
 * 背景 (根因): harness 在目标项目里落的 bootstrap 产物 (`.claude/` / `.opencode/` /
 * `.loop-engineering/` / `.worktrees/` / `runs/` / `resume.cmd` / `resume.sh`) 会被
 * `git status --porcelain` 当 untracked 列出, 进而被 actual_writes 的 tryGitDiff 采集进
 * `actual_writes.paths`, 被 checkBoundary 误判为 implementation-worker「越界写入源码」。
 *
 * 本模块给出两处复用能力:
 *   1. isHarnessInternal(rel): actual_writes 采集时据此过滤掉 harness 自身路径 (治根,
 *      无论目标仓库 gitignore 是否干净都不误判)。
 *   2. ensureHarnessGitignore / removeHarnessGitignore: adapter-cc install/uninstall 时在
 *      目标项目 `.gitignore` 维护一个托管块, 把这些产物 ignore 掉 (保持目标仓库 git status 干净)。
 *
 * 所有 IO 走 node:fs 同步 API, 编码 utf-8, 换行统一 `\n`。
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** harness 自身产生的内部目录 (相对目标项目根)。 */
export const HARNESS_INTERNAL_DIRS = [
  ".claude",
  ".opencode",
  ".loop-engineering",
  ".worktrees",
  "runs",
] as const;

/** harness 自身产生的内部文件 (相对目标项目根)。 */
export const HARNESS_INTERNAL_FILES = ["resume.cmd", "resume.sh"] as const;

/**
 * 判定相对路径是否属于 harness 自身 bootstrap 产物。
 *
 * 归一化: 反斜杠 → `/`, 去掉尾部斜杠 (git porcelain 对 untracked 目录会给出带尾斜杠的
 * 形如 `.claude/`, 务必先去尾斜杠再判)。判定:
 *   - 等于任一 HARNESS_INTERNAL_FILES → true
 *   - 等于某个 HARNESS_INTERNAL_DIRS 或以 `<dir>/` 开头 → true
 *   - 否则 false (注意 `runspace/x` 前缀相近但非 `runs/`, 不命中)
 */
export function isHarnessInternal(rel: string): boolean {
  if (!rel) return false;
  // 反斜杠归一化 + 去尾部斜杠 (可能多个)
  const norm = rel.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!norm) return false;
  if ((HARNESS_INTERNAL_FILES as readonly string[]).includes(norm)) return true;
  for (const dir of HARNESS_INTERNAL_DIRS) {
    if (norm === dir || norm.startsWith(`${dir}/`)) return true;
  }
  return false;
}

/** gitignore 托管块内每行的 ignore 条目 (目录带尾斜杠, 文件不带)。 */
export const HARNESS_GITIGNORE_ENTRIES = [
  ".claude/",
  ".opencode/",
  ".loop-engineering/",
  ".worktrees/",
  "runs/",
  "resume.cmd",
  "resume.sh",
] as const;

/** 托管块起始标记 (定位/替换/删除时以此为锚)。 */
const BEGIN = "# >>> loop-engineering managed >>>";
/** 托管块结束标记。 */
const END = "# <<< loop-engineering managed <<<";
/** 块内说明注释 (提示用户勿手改)。 */
const NOTE = "# loop-engineering 自动维护, 勿手改";

/** 构造完整托管块文本 (不含末尾换行)。 */
function buildBlock(): string {
  const lines = [BEGIN, NOTE, ...HARNESS_GITIGNORE_ENTRIES, END];
  return lines.join("\n");
}

/** 定位文件中托管块的字符区间 [start, end) (含 BEGIN 行、含 END 行), 无则返回 null。 */
function locateBlock(content: string): { start: number; end: number } | null {
  const beginIdx = content.indexOf(BEGIN);
  if (beginIdx === -1) return null;
  const endMarkerIdx = content.indexOf(END, beginIdx);
  if (endMarkerIdx === -1) return null;
  // END 行的行尾 (含该行, 不含换行符本身)
  const endLineEnd = endMarkerIdx + END.length;
  return { start: beginIdx, end: endLineEnd };
}

/**
 * 在目标项目 `.gitignore` 写/更新 harness 托管块。
 *
 * 幂等硬要求: 连续两次调用, 第二次必须返回 "unchanged" 且不改文件。
 *
 * @returns
 *   - "written":   文件原本不存在, 已写入「块 + 末尾换行」
 *   - "updated":   文件存在, 追加了新块 / 用新块替换了旧块 (内容有变)
 *   - "unchanged": 文件已含等价托管块, 未改动
 */
export function ensureHarnessGitignore(
  projectDir: string,
): "written" | "updated" | "unchanged" {
  const target = path.join(projectDir, ".gitignore");
  const block = buildBlock();

  if (!fs.existsSync(target)) {
    // 文件不存在 → 写入「块 + 末尾换行」
    fs.writeFileSync(target, `${block}\n`, "utf-8");
    return "written";
  }

  const original = fs.readFileSync(target, "utf-8");
  const loc = locateBlock(original);

  if (loc) {
    // 已含托管块 → 用新块整体替换旧块 (BEGIN..END 之间的内容)
    const next = original.slice(0, loc.start) + block + original.slice(loc.end);
    if (next === original) return "unchanged";
    fs.writeFileSync(target, next, "utf-8");
    return "updated";
  }

  // 无托管块 → 末尾追加 (前面补足一个空行分隔)。
  // 去掉原文件尾部空白后拼: <原内容>\n\n<块>\n
  const trimmed = original.replace(/\s*$/, "");
  const next =
    trimmed.length > 0 ? `${trimmed}\n\n${block}\n` : `${block}\n`;
  fs.writeFileSync(target, next, "utf-8");
  return "updated";
}

/**
 * 从目标项目 `.gitignore` 删除 harness 托管块。
 *
 * @returns
 *   - "notfound": 无文件或无托管块 (对「文件不存在」正常返回, 不抛)
 *   - "removed":  删除了托管块 (连同其前多余空行); 若剩余内容为空/纯空白则整文件删除
 */
export function removeHarnessGitignore(projectDir: string): "removed" | "notfound" {
  const target = path.join(projectDir, ".gitignore");
  if (!fs.existsSync(target)) return "notfound";

  const original = fs.readFileSync(target, "utf-8");
  const loc = locateBlock(original);
  if (!loc) return "notfound";

  // 删除 BEGIN..END 区间, 连同其前的多余空白 (换行/空行) 一并回收, 避免留下空洞
  const before = original.slice(0, loc.start).replace(/\s*$/, "");
  const after = original.slice(loc.end);
  let next = before + after;

  // 剩余内容为空/纯空白 → 删除整个 .gitignore 文件
  if (next.trim() === "") {
    fs.rmSync(target, { force: true });
    return "removed";
  }

  // 否则写回 (规范尾部: 去尾部空白后补一个换行)
  next = next.replace(/\s*$/, "") + "\n";
  fs.writeFileSync(target, next, "utf-8");
  return "removed";
}
