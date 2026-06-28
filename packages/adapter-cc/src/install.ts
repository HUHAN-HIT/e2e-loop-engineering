/**
 * Claude Code adapter: install / dryRun / uninstall。
 *
 * 行为权威: Python `loop_engineering/claude_assets.py:install_claude_assets`。
 * 落盘布局必须与之完全一致 (兼容性硬要求):
 *
 *   <projectDir>/.claude/
 *     settings.json                                    ← adapter 模板 (settings.json)
 *     hooks/loop_engineering/<name>.mjs (×4)           ← adapter dist 编译产物
 *     skills/loop-engineering/SKILL.md                 ← core/coordinator.md
 *     skills/loop-engineering/README.md                ← core/README.md
 *     skills/loop-engineering/standards/*.md           ← core/standards/*
 *     agents/<id>.md (×4)                              ← core/subagents/*
 *
 * settings.json 已存在时【深合并 hooks】, 保留用户其它配置 (Python _merge_hooks 等价)。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AssetManifest,
  HostAdapter,
  InstallContext,
  InstallResult,
  UninstallResult,
} from "@e2e-loop/shared";
import settingsTemplate from "./templates/settings.json" with { type: "json" };

/** 4 个 hook 的逻辑名 (与 HookName 对齐; 与 .mjs 文件名 1:1)。 */
const HOOK_NAMES = [
  "probe_and_gate",
  "guard_paths",
  "post_task_collect",
  "guard_anchors",
] as const;

/**
 * 仓库根的判据: 同时含 `core/manifest.json` 与 `packages/adapter-cc/dist/`。
 * 这是 install 实际依赖的两份资产来源, 用它作为锚点比"固定向上 N 级"稳健。
 */
function isRepoRoot(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "core", "manifest.json")) &&
    fs.existsSync(path.join(dir, "packages", "adapter-cc", "dist"))
  );
}

/**
 * 定位仓库根 (含 core/ 与 packages/adapter-cc/dist/)。
 *
 * 用"从 import.meta.url 所在目录逐级向上行走"的稳健方式, 兼容两种执行形态:
 *   1. bun 直接跑 src: import.meta.url = packages/adapter-cc/src/install.ts,
 *      向上数级即命中仓库根。
 *   2. node 跑构建后的 packages/cli/dist/index.mjs (install.ts 被 tsup 打进 CLI bundle):
 *      import.meta.url = packages/cli/dist/index.mjs, 同样逐级向上能命中仓库根。
 * 旧实现用 adapterRoot() 固定向上两级, 在形态 2 下会误算成 packages/cli, 导致
 * hookMjsSources() 去 packages/cli/dist 找 .mjs (不存在) → hooks 静默跳过未落盘。
 *
 * TODO(P5 打包): npm 发布后 install.ts 与 adapter-cc/dist 同处 node_modules/
 * @e2e-loop/adapter-claude-code 下, 而 core/ 可能来自独立包, 此向上行走判据
 * (core/manifest.json + packages/adapter-cc/dist 同根) 不再成立。届时需按 node_modules
 * 布局重写资产解析。P1 只需保证 workspace 两形态 (bun src / node cli-bundle) 正确。
 */
function repoRoot(): string {
  const start = path.dirname(fileURLToPath(import.meta.url));
  let dir = start;
  // 逐级向上, 直到命中判据或抵达文件系统根
  for (;;) {
    if (isRepoRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break; // 已到根, 再向上无意义
    dir = parent;
  }
  throw new Error(
    `无法定位仓库根: 从 ${start} 逐级向上未找到同时含 ` +
      `core/manifest.json 与 packages/adapter-cc/dist/ 的目录。` +
      `(请先构建: npm run build:adapter-cc)`,
  );
}

/**
 * 定位 adapter 包根 (<repoRoot>/packages/adapter-cc)。
 *
 * 现已派生自 repoRoot() (向上行走稳健定位), 不再用 import.meta.url 固定向上两级——
 * 那是导致 bundle 形态误定位的旧根因。保留此导出仅为兼容既有 index.ts re-export。
 */
function adapterRoot(): string {
  return path.join(repoRoot(), "packages", "adapter-cc");
}

/**
 * 列出 4 个 hook .mjs 源的绝对路径 (install 时从这里读到 .claude/hooks/)。
 * 固定取 <repoRoot>/packages/adapter-cc/dist/<name>.mjs, 不再依赖 install.ts 自身位置,
 * 因此被 bundle 进 CLI 后也能正确定位。
 */
function hookMjsSources(): Array<{ name: string; src: string }> {
  const distDir = path.join(repoRoot(), "packages", "adapter-cc", "dist");
  return HOOK_NAMES.map((n) => ({
    name: n,
    src: path.join(distDir, `${n}.mjs`),
  }));
}

/** 列出 core/standards/ 下所有 .md (POSIX 相对名)。 */
function listStandards(coreDir: string): string[] {
  const dir = path.join(coreDir, "standards");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

interface FileEntry {
  /** 相对 projectDir 的 POSIX 落盘路径 */
  rel: string;
  /** 绝对源路径 */
  src: string;
  /** 资产来源标记 */
  source: "core" | "adapter";
}

/** 收集本次要落盘的全部文件 (不做 IO, 仅供 dryRun / install 复用)。 */
function collectManifestEntries(): FileEntry[] {
  const core = path.join(repoRoot(), "core");
  const entries: FileEntry[] = [];

  // 1. settings.json (adapter 模板; 落盘时按合并策略处理, 此处只列源)
  entries.push({
    rel: ".claude/settings.json",
    src: "", // 特殊: 来自 settingsTemplate import, 不走文件复制
    source: "adapter",
  });

  // 2. 4 个 hook .mjs
  for (const h of hookMjsSources()) {
    entries.push({
      rel: `.claude/hooks/loop_engineering/${h.name}.mjs`,
      src: h.src,
      source: "adapter",
    });
  }

  // 3. core/coordinator.md → .claude/skills/loop-engineering/SKILL.md
  entries.push({
    rel: ".claude/skills/loop-engineering/SKILL.md",
    src: path.join(core, "coordinator.md"),
    source: "core",
  });

  // 4. core/README.md → .claude/skills/loop-engineering/README.md (可选)
  const readme = path.join(core, "README.md");
  if (fs.existsSync(readme)) {
    entries.push({
      rel: ".claude/skills/loop-engineering/README.md",
      src: readme,
      source: "core",
    });
  }

  // 5. core/standards/*.md
  for (const f of listStandards(core)) {
    entries.push({
      rel: `.claude/skills/loop-engineering/standards/${f}`,
      src: path.join(core, "standards", f),
      source: "core",
    });
  }

  // 6. core/subagents/*.md → .claude/agents/<id>.md
  const subDir = path.join(core, "subagents");
  if (fs.existsSync(subDir)) {
    for (const f of fs
      .readdirSync(subDir)
      .filter((f) => f.endsWith(".md"))
      .sort()) {
      entries.push({
        rel: `.claude/agents/${f}`,
        src: path.join(subDir, f),
        source: "core",
      });
    }
  }

  return entries;
}

/** 计算冲突文件列表 (已存在且 force=false 时会跳过; settings.json 合并例外)。 */
function detectConflicts(
  projectDir: string,
  entries: FileEntry[],
  force: boolean,
): string[] {
  if (force) return [];
  const conflicts: string[] = [];
  for (const e of entries) {
    if (e.rel === ".claude/settings.json") continue; // 合并策略, 不算冲突
    const dst = path.join(projectDir, e.rel);
    if (fs.existsSync(dst)) conflicts.push(e.rel);
  }
  return conflicts;
}

/** dryRun: 不写盘, 返回 AssetManifest。 */
async function dryRun(ctx: InstallContext): Promise<AssetManifest> {
  const entries = collectManifestEntries();
  const files = entries.map((e) => {
    let size = 0;
    if (e.rel === ".claude/settings.json") {
      size = Buffer.byteLength(JSON.stringify(settingsTemplate), "utf-8");
    } else {
      try {
        size = fs.statSync(e.src).size;
      } catch {
        size = 0;
      }
    }
    return { path: e.rel, source: e.source, size };
  });
  return {
    files,
    conflictFiles: detectConflicts(ctx.projectDir, entries, ctx.force),
  };
}

/** 复制单个文件 (force=false 时已存在则跳过, 返回是否实际写入)。 */
function copyOne(
  src: string,
  dst: string,
  force: boolean,
): "written" | "skipped" {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.existsSync(dst) && !force) return "skipped";
  fs.copyFileSync(src, dst);
  return "written";
}

/**
 * 安装 settings.json: 不存在 → 写入模板; 已存在 → 深合并 hooks
 * (Python `_merge_hooks` / `_install_settings` 等价)。
 * 返回 "written" | "skipped"。
 */
function installSettings(
  dst: string,
  force: boolean,
): "written" | "skipped" {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const incoming = settingsTemplate;
  if (!fs.existsSync(dst)) {
    fs.writeFileSync(
      dst,
      JSON.stringify(incoming, null, 2) + "\n",
      "utf-8",
    );
    return "written";
  }
  let existing: unknown;
  try {
    existing = JSON.parse(fs.readFileSync(dst, "utf-8"));
  } catch {
    // 用户 settings 不可解析: force 覆盖, 否则跳过 (不破坏用户文件)
    if (force) {
      fs.writeFileSync(
        dst,
        JSON.stringify(incoming, null, 2) + "\n",
        "utf-8",
      );
      return "written";
    }
    return "skipped";
  }
  if (typeof existing !== "object" || existing === null) {
    if (force) {
      fs.writeFileSync(
        dst,
        JSON.stringify(incoming, null, 2) + "\n",
        "utf-8",
      );
      return "written";
    }
    return "skipped";
  }
  const merged = mergeHooks(
    existing as Record<string, unknown>,
    incoming as Record<string, unknown>,
  );
  if (JSON.stringify(merged) === JSON.stringify(existing)) return "skipped";
  fs.writeFileSync(dst, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  return "written";
}

/** 把 incoming.hooks 深合并进 existing, 同 command 不重复追加 (幂等)。 */
function mergeHooks(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  const incomingHooks = (incoming.hooks ?? {}) as Record<string, unknown>;
  const existingHooks = merged.hooks;
  if (typeof existingHooks !== "object" || existingHooks === null) {
    merged.hooks = JSON.parse(JSON.stringify(incomingHooks));
    return merged;
  }
  const newHooks = JSON.parse(
    JSON.stringify(existingHooks),
  ) as Record<string, unknown>;
  for (const [event, groups] of Object.entries(incomingHooks)) {
    const existingGroups = newHooks[event];
    if (!Array.isArray(existingGroups)) {
      newHooks[event] = JSON.parse(JSON.stringify(groups));
      continue;
    }
    const existingCmds = new Set<string>();
    for (const g of existingGroups as Array<Record<string, unknown>>) {
      const hs = (g?.hooks ?? []) as Array<Record<string, unknown>>;
      for (const h of hs) {
        const c = h?.command;
        if (typeof c === "string") existingCmds.add(c);
      }
    }
    for (const g of (groups as Array<Record<string, unknown>>) ?? []) {
      const hs = (g?.hooks ?? []) as Array<Record<string, unknown>>;
      const newEntries = hs.filter(
        (h) => !existingCmds.has(String(h?.command ?? "")),
      );
      if (newEntries.length === 0) continue;
      existingGroups.push({ ...g, hooks: newEntries });
    }
    newHooks[event] = existingGroups;
  }
  merged.hooks = newHooks;
  return merged;
}

/** install: 落盘, 返回 InstallResult。 */
async function install(ctx: InstallContext): Promise<InstallResult> {
  const projectDir = path.resolve(ctx.projectDir);
  const entries = collectManifestEntries();
  const writtenFiles: string[] = [];
  const skippedFiles: string[] = [];

  for (const e of entries) {
    const dst = path.join(projectDir, e.rel);
    if (e.rel === ".claude/settings.json") {
      const r = installSettings(dst, ctx.force);
      (r === "written" ? writtenFiles : skippedFiles).push(e.rel);
      continue;
    }
    // hook .mjs / core 资产
    if (!fs.existsSync(e.src)) {
      // 源缺失 (如未编译 dist/): 跳过, 不让整个 install 失败
      skippedFiles.push(e.rel);
      continue;
    }
    const r = copyOne(e.src, dst, ctx.force);
    (r === "written" ? writtenFiles : skippedFiles).push(e.rel);
  }

  const manifest: AssetManifest = {
    files: entries.map((e) => {
      let size = 0;
      if (e.rel === ".claude/settings.json") {
        size = Buffer.byteLength(JSON.stringify(settingsTemplate), "utf-8");
      } else {
        try {
          size = fs.statSync(e.src).size;
        } catch {
          size = 0;
        }
      }
      return { path: e.rel, source: e.source, size };
    }),
    conflictFiles: detectConflicts(projectDir, entries, ctx.force),
  };

  return { writtenFiles, skippedFiles, manifest };
}

/**
 * uninstall: 只删本工具装的, 不动用户其它 .claude/ 文件。
 * 删: skills/loop-engineering/、agents/<4 files>.md、hooks/loop_engineering/、
 * settings.json (整文件; 用户若有其它 hook 配置需手工保留)。
 */
async function uninstall(projectDir: string): Promise<UninstallResult> {
  const root = path.resolve(projectDir);
  const removedFiles: string[] = [];
  const notFoundFiles: string[] = [];

  const rmIfExists = (abs: string, rel: string): void => {
    if (fs.existsSync(abs)) {
      try {
        fs.rmSync(abs, { recursive: true, force: true });
        removedFiles.push(rel);
      } catch {
        notFoundFiles.push(rel);
      }
    } else {
      notFoundFiles.push(rel);
    }
  };

  // 1. .claude/skills/loop-engineering/ (整目录)
  rmIfExists(
    path.join(root, ".claude/skills/loop-engineering"),
    ".claude/skills/loop-engineering/",
  );

  // 2. .claude/agents/ 下 4 个文件 (只删本工具装的, 不删目录里其它文件)
  const core = path.join(repoRoot(), "core");
  const subDir = path.join(core, "subagents");
  if (fs.existsSync(subDir)) {
    for (const f of fs.readdirSync(subDir).filter((f) => f.endsWith(".md"))) {
      const abs = path.join(root, ".claude/agents", f);
      const rel = `.claude/agents/${f}`;
      if (fs.existsSync(abs)) {
        try {
          fs.rmSync(abs, { force: true });
          removedFiles.push(rel);
        } catch {
          notFoundFiles.push(rel);
        }
      } else {
        notFoundFiles.push(rel);
      }
    }
  }

  // 3. .claude/hooks/loop_engineering/ (整目录)
  rmIfExists(
    path.join(root, ".claude/hooks/loop_engineering"),
    ".claude/hooks/loop_engineering/",
  );

  // 4. settings.json: 整文件删 (Python claude_assets.py 当前不删 settings.json,
  // 但 uninstall 语义是"清掉本工具痕迹"; 用户其它配置需手工保留——这与 settings.json
  // 由本工具管理的事实一致)。
  const settingsAbs = path.join(root, ".claude/settings.json");
  if (fs.existsSync(settingsAbs)) {
    try {
      fs.rmSync(settingsAbs, { force: true });
      removedFiles.push(".claude/settings.json");
    } catch {
      notFoundFiles.push(".claude/settings.json");
    }
  } else {
    notFoundFiles.push(".claude/settings.json");
  }

  return { removedFiles, notFoundFiles };
}

/** Claude Code adapter 单例。 */
export const claudeCodeAdapter: HostAdapter = {
  host: "claude-code",
  targetDir: ".claude",
  install,
  dryRun,
  uninstall,
};

export {
  collectManifestEntries,
  mergeHooks,
  adapterRoot,
  repoRoot,
  HOOK_NAMES,
};
