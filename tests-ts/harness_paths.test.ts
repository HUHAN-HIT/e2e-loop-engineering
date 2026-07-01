/**
 * harness_paths 单元测试。
 *
 * 被测实现: packages/shared/src/harness_paths.ts。
 * 覆盖三块:
 *   - isHarnessInternal: harness 自身 bootstrap 产物判定 (含尾斜杠 / 反斜杠归一化 / 前缀相近反例)
 *   - ensureHarnessGitignore: 首写 / 幂等 / 已有用户内容追加保留
 *   - removeHarnessGitignore: 纯托管块整文件删 / 保留用户内容 / 无文件 notfound
 *
 * 临时目录走 os.tmpdir + mkdtempSync, 结束统一清理。
 */
import { test, expect } from "bun:test";
import {
  isHarnessInternal,
  ensureHarnessGitignore,
  removeHarnessGitignore,
} from "@e2e-loop/shared";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── 临时目录夹具 ────────────────────────────────────────────────────────────
const _tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  _tmpDirs.push(d);
  return d;
}
function cleanup(): void {
  while (_tmpDirs.length) {
    try {
      fs.rmSync(_tmpDirs.pop()!, { recursive: true, force: true });
    } catch {
      /* Windows 杀软扫描偶发占用, 忽略清理失败 */
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// isHarnessInternal
// ═══════════════════════════════════════════════════════════════════════════

test("[isHarnessInternal] harness 目录内文件 / 尾斜杠目录 → true", () => {
  // 目录内文件
  expect(isHarnessInternal(".claude/settings.json")).toBe(true);
  // git porcelain 对 untracked 目录给出带尾斜杠形如 ".claude/"
  expect(isHarnessInternal(".claude/")).toBe(true);
  // runs/ 深层路径
  expect(isHarnessInternal("runs/20260701-001/tasks/x/summary.md")).toBe(true);
  // .loop-engineering / .worktrees
  expect(isHarnessInternal(".loop-engineering/worktree.json")).toBe(true);
  expect(isHarnessInternal(".worktrees/20260701-001/x")).toBe(true);
});

test("[isHarnessInternal] harness 文件 (resume.cmd/sh) → true", () => {
  expect(isHarnessInternal("resume.cmd")).toBe(true);
  expect(isHarnessInternal("resume.sh")).toBe(true);
});

test("[isHarnessInternal] 反斜杠归一化后判定 (runs\\x\\y.md) → true", () => {
  expect(isHarnessInternal("runs\\x\\y.md")).toBe(true);
  expect(isHarnessInternal(".claude\\settings.json")).toBe(true);
});

test("[isHarnessInternal] 反例: 源码 / 前缀相近 / 非 .claude → false", () => {
  // 真实源码
  expect(isHarnessInternal("src/index.ts")).toBe(false);
  // 前缀相近但非 runs/ (runspace ≠ runs)
  expect(isHarnessInternal("runspace/x.ts")).toBe(false);
  // 非 .claude/ (my.claude ≠ .claude)
  expect(isHarnessInternal("my.claude/x")).toBe(false);
  // 空串
  expect(isHarnessInternal("")).toBe(false);
});

// ═══════════════════════════════════════════════════════════════════════════
// ensureHarnessGitignore
// ═══════════════════════════════════════════════════════════════════════════

test("[ensureHarnessGitignore] 空目录首次 → written, 含 BEGIN/END 与全部 entries", () => {
  const dir = mkTmp("hp-ensure-new-");
  const r = ensureHarnessGitignore(dir);
  expect(r).toBe("written");
  const content = fs.readFileSync(path.join(dir, ".gitignore"), "utf-8");
  expect(content).toContain("# >>> loop-engineering managed >>>");
  expect(content).toContain("# <<< loop-engineering managed <<<");
  for (const entry of [
    ".claude/",
    ".opencode/",
    ".loop-engineering/",
    ".worktrees/",
    "runs/",
    "resume.cmd",
    "resume.sh",
  ]) {
    expect(content).toContain(entry);
  }
});

test("[ensureHarnessGitignore] 幂等: 第二次 → unchanged 且字节不变", () => {
  const dir = mkTmp("hp-ensure-idem-");
  ensureHarnessGitignore(dir);
  const first = fs.readFileSync(path.join(dir, ".gitignore"), "utf-8");
  const r2 = ensureHarnessGitignore(dir);
  expect(r2).toBe("unchanged");
  const second = fs.readFileSync(path.join(dir, ".gitignore"), "utf-8");
  expect(second).toBe(first);
});

test("[ensureHarnessGitignore] 已有用户内容 → updated 且保留用户内容 + 追加块; 再调 unchanged", () => {
  const dir = mkTmp("hp-ensure-append-");
  const target = path.join(dir, ".gitignore");
  fs.writeFileSync(target, "node_modules/\n", "utf-8");
  const r = ensureHarnessGitignore(dir);
  expect(r).toBe("updated");
  const content = fs.readFileSync(target, "utf-8");
  // 用户内容不丢
  expect(content).toContain("node_modules/");
  // 托管块追加进去
  expect(content).toContain("# >>> loop-engineering managed >>>");
  expect(content).toContain("runs/");
  // 再调幂等
  const r2 = ensureHarnessGitignore(dir);
  expect(r2).toBe("unchanged");
  expect(fs.readFileSync(target, "utf-8")).toBe(content);
});

// ═══════════════════════════════════════════════════════════════════════════
// removeHarnessGitignore
// ═══════════════════════════════════════════════════════════════════════════

test("[removeHarnessGitignore] 只含托管块 → removed 且文件被删除", () => {
  const dir = mkTmp("hp-remove-only-");
  ensureHarnessGitignore(dir);
  const target = path.join(dir, ".gitignore");
  expect(fs.existsSync(target)).toBe(true);
  const r = removeHarnessGitignore(dir);
  expect(r).toBe("removed");
  // 剩余全空 → 整文件删
  expect(fs.existsSync(target)).toBe(false);
});

test("[removeHarnessGitignore] 含用户内容 + 块 → removed 且保留用户内容, 块消失", () => {
  const dir = mkTmp("hp-remove-keep-");
  const target = path.join(dir, ".gitignore");
  fs.writeFileSync(target, "node_modules/\ndist/\n", "utf-8");
  ensureHarnessGitignore(dir);
  const r = removeHarnessGitignore(dir);
  expect(r).toBe("removed");
  expect(fs.existsSync(target)).toBe(true);
  const content = fs.readFileSync(target, "utf-8");
  // 用户内容保留
  expect(content).toContain("node_modules/");
  expect(content).toContain("dist/");
  // 托管块消失
  expect(content).not.toContain("# >>> loop-engineering managed");
});

test("[removeHarnessGitignore] 无文件 → notfound", () => {
  const dir = mkTmp("hp-remove-nofile-");
  expect(removeHarnessGitignore(dir)).toBe("notfound");
});

test("[清理] 删除全部临时目录夹具", () => {
  cleanup();
  expect(_tmpDirs.length).toBe(0);
});
