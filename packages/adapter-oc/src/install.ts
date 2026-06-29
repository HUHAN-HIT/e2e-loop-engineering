/**
 * OpenCode adapter: install / dryRun / uninstall。
 *
 * 落盘布局 (规范源: docs/loop-engineering-cross-host-design.md §6/§7):
 *
 *   <projectDir>/.claude/skills/loop-engineering/
 *     SKILL.md                ← core/coordinator.md (与 Claude Code 共享同一文件;
 *                                OpenCode 原生支持 Claude 兼容路径 .claude/skills/<name>/SKILL.md)
 *     README.md               ← core/README.md (若存在)
 *     standards/*.md          ← core/standards/*
 *   <projectDir>/.opencode/
 *     agents/<id>.md (×4)     ← core/subagents/* (需 frontmatter 转换: CC tools → OC permission)
 *     plugins/loop-engineering.js ← packages/adapter-oc/dist/loop-engineering.js (4 hook 等价 plugin bundle;
 *                                dist 未构建则跳过, 不让 install 失败)
 *     opencode.json           ← 合并安全写入 (permission.skill = "allow")
 *
 * 与 adapter-cc 的差异:
 * - hook 形态不同: CC 装 4 个 .mjs (stdin/stdout); OC 装 1 个 plugin .js (OC plugin API)。
 *   逻辑层 (@e2e-loop/shared) 完全复用, 只 binding 层不同。
 * - 不写 settings.json (OpenCode plugin 启动自动加载, 无需配置注册)。
 * - subagent 走 `.opencode/agents/` (复数; OpenCode 不读 `.claude/agents/`), 且 frontmatter 重写。
 * - 配置文件是 opencode.json (合并策略保证 permission.skill 存在)。
 *
 * install/dryRun/uninstall 与 adapter-cc 同构 (force 语义、conflictFiles、幂等、uninstall 只删本工具装的)。
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
import {
  defaultOpencodeConfig,
  mergeOpencodeConfig,
  renderOpencodeAgent,
} from "./render.js";

/**
 * 仓库根的判据: 含 `core/manifest.json`。
 *
 * OpenCode adapter 不依赖任何 adapter dist (无 hooks), 因此只用 core/manifest.json 作锚点即可,
 * 比 adapter-cc 的 "core + adapter-cc/dist 同根" 判据更宽松——OC install 唯一资产来源就是 core/。
 */
function isRepoRoot(dir: string): boolean {
  return fs.existsSync(path.join(dir, "core", "manifest.json"));
}

/**
 * 定位仓库根 (含 core/)。
 *
 * 与 adapter-cc 相同的 "从 import.meta.url 所在目录逐级向上行走" 策略, 兼容两种执行形态:
 *   1. bun 直接跑 src: import.meta.url = packages/adapter-oc/src/install.ts, 向上数级命中仓库根。
 *   2. node 跑构建后的 CLI bundle (install.ts 被 tsup 打进 CLI): import.meta.url = packages/cli/dist/...,
 *      同样逐级向上能命中含 core/manifest.json 的仓库根。
 */
function repoRoot(): string {
  const start = path.dirname(fileURLToPath(import.meta.url));
  const bundledAssets = path.join(start, "assets");
  if (isRepoRoot(bundledAssets)) return bundledAssets;

  let dir = start;
  for (;;) {
    if (isRepoRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `无法定位仓库根: 从 ${start} 逐级向上未找到含 core/manifest.json 的目录。`,
  );
}

/** 列出 core/standards/ 下所有 .md (POSIX 相对名, 升序)。 */
function listStandards(coreDir: string): string[] {
  const dir = path.join(coreDir, "standards");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

/** 列出 core/subagents/ 下所有 .md 文件名 (升序; id 即去掉 .md 的部分)。 */
function listSubagents(coreDir: string): string[] {
  const dir = path.join(coreDir, "subagents");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

/**
 * OpenCode plugin bundle 的源路径 (<repoRoot>/packages/adapter-oc/dist/loop-engineering.js)。
 *
 * 由 `npm run build:adapter-oc-plugin` (tsup) 产出。install 时复制到目标项目
 * .opencode/plugins/loop-engineering.js。dist 未构建时此文件不存在, install 会按"源缺失即跳过"处理
 * (镜像 adapter-cc 对未编译 hook .mjs 的容忍), 不让整个 install 失败。
 */
function pluginBundleSrc(): string {
  return path.join(
    repoRoot(),
    "packages",
    "adapter-oc",
    "dist",
    "loop-engineering.js",
  );
}

/** 落盘条目的渲染方式。 */
type RenderKind =
  /** 纯文件复制 (SKILL/README/standards) */
  | "copy"
  /** subagent frontmatter 转换 (CC → OC) */
  | "agent"
  /** opencode.json 合并安全写入 */
  | "config";

interface FileEntry {
  /** 相对 projectDir 的 POSIX 落盘路径 */
  rel: string;
  /** 绝对源路径 (config 类无源文件, 为空) */
  src: string;
  /** 资产来源标记 */
  source: "core" | "adapter";
  /** 落盘渲染方式 */
  kind: RenderKind;
}

/** 收集本次要落盘的全部文件 (不做 IO, 仅供 dryRun / install 复用)。 */
function collectManifestEntries(): FileEntry[] {
  const core = path.join(repoRoot(), "core");
  const entries: FileEntry[] = [];

  // 1. core/coordinator.md → .claude/skills/loop-engineering/SKILL.md (与 CC 共享路径)
  entries.push({
    rel: ".claude/skills/loop-engineering/SKILL.md",
    src: path.join(core, "coordinator.md"),
    source: "core",
    kind: "copy",
  });

  // 2. core/README.md → .claude/skills/loop-engineering/README.md (可选)
  const readme = path.join(core, "README.md");
  if (fs.existsSync(readme)) {
    entries.push({
      rel: ".claude/skills/loop-engineering/README.md",
      src: readme,
      source: "core",
      kind: "copy",
    });
  }

  // 3. core/standards/*.md → .claude/skills/loop-engineering/standards/*.md
  for (const f of listStandards(core)) {
    entries.push({
      rel: `.claude/skills/loop-engineering/standards/${f}`,
      src: path.join(core, "standards", f),
      source: "core",
      kind: "copy",
    });
  }

  // 4. core/subagents/<id>.md → .opencode/agents/<id>.md (frontmatter 转换)
  for (const f of listSubagents(core)) {
    entries.push({
      rel: `.opencode/agents/${f}`,
      src: path.join(core, "subagents", f),
      source: "core",
      kind: "agent",
    });
  }

  // 5. plugin bundle → .opencode/plugins/loop-engineering.js (4 hook 等价; 纯复制)
  //    dist 未构建时 src 不存在, install 会"源缺失即跳过", manifest 仍列出此条 (size=0)。
  entries.push({
    rel: ".opencode/plugins/loop-engineering.js",
    src: pluginBundleSrc(),
    source: "adapter",
    kind: "copy",
  });

  // 6. opencode.json (合并安全写入; 无源文件)
  entries.push({
    rel: ".opencode/opencode.json",
    src: "",
    source: "adapter",
    kind: "config",
  });

  return entries;
}

/**
 * 计算冲突文件列表 (已存在且 force=false 时会跳过)。
 * opencode.json 走合并策略, 永不算冲突 (镜像 adapter-cc settings.json 例外)。
 */
function detectConflicts(
  projectDir: string,
  entries: FileEntry[],
  force: boolean,
): string[] {
  if (force) return [];
  const conflicts: string[] = [];
  for (const e of entries) {
    if (e.kind === "config") continue; // 合并策略, 不算冲突
    const dst = path.join(projectDir, e.rel);
    if (fs.existsSync(dst)) conflicts.push(e.rel);
  }
  return conflicts;
}

/** 计算单个条目的落盘字节数 (供 manifest 用)。 */
function entrySize(e: FileEntry): number {
  if (e.kind === "config") {
    return Buffer.byteLength(
      JSON.stringify(defaultOpencodeConfig(), null, 2) + "\n",
      "utf-8",
    );
  }
  if (e.kind === "agent") {
    // 转换后体积与源略有出入, 但 manifest size 仅作参考, 用源大小近似即可
    try {
      return fs.statSync(e.src).size;
    } catch {
      return 0;
    }
  }
  try {
    return fs.statSync(e.src).size;
  } catch {
    return 0;
  }
}

/** dryRun: 不写盘, 返回 AssetManifest。 */
async function dryRun(ctx: InstallContext): Promise<AssetManifest> {
  const entries = collectManifestEntries();
  const files = entries.map((e) => ({
    path: e.rel,
    source: e.source,
    size: entrySize(e),
  }));
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
 * 备份用户不可解析的 opencode.json (force=true 覆盖前的保护)。
 *
 * 命名: opencode.json.loop-engineering.bak (与原文件同目录, 用户可肉眼看到并手动恢复)。
 * 失败不抛 (备份是 best-effort 保护), 仅 stderr 提示。
 */
function backupUnparseableConfig(dst: string): void {
  try {
    const bak = `${dst}.loop-engineering.bak`;
    fs.copyFileSync(dst, bak);
    process.stderr.write(
      `[loop-engineering] 用户 opencode.json 不可解析, 已备份至 ${bak} 后覆盖。\n`,
    );
  } catch (e) {
    process.stderr.write(
      `[loop-engineering] opencode.json 备份失败 (best-effort 跳过): ${
        e instanceof Error ? e.message : String(e)
      }\n`,
    );
  }
}

/** 渲染并写出单个 OpenCode agent (frontmatter 转换; force=false 时已存在则跳过)。 */
function writeAgent(
  src: string,
  dst: string,
  force: boolean,
): "written" | "skipped" {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.existsSync(dst) && !force) return "skipped";
  const ccMarkdown = fs.readFileSync(src, "utf-8");
  const rendered = renderOpencodeAgent(ccMarkdown);
  fs.writeFileSync(dst, rendered, "utf-8");
  return "written";
}

/**
 * 安装 opencode.json: 不存在 → 写默认配置; 已存在 → 深合并 (确保 permission.skill 存在)。
 * 不可解析时: force 覆盖, 否则跳过 (不毁用户文件)。镜像 adapter-cc installSettings 的健壮性。
 * 返回 "written" | "skipped"。
 */
function installConfig(dst: string, force: boolean): "written" | "skipped" {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const fallback = defaultOpencodeConfig();

  if (!fs.existsSync(dst)) {
    fs.writeFileSync(dst, JSON.stringify(fallback, null, 2) + "\n", "utf-8");
    return "written";
  }

  let existing: unknown;
  try {
    existing = JSON.parse(fs.readFileSync(dst, "utf-8"));
  } catch {
    // 不可解析: force 覆盖前先备份 (避免破坏用户原始配置), 否则跳过
    if (force) {
      backupUnparseableConfig(dst);
      fs.writeFileSync(dst, JSON.stringify(fallback, null, 2) + "\n", "utf-8");
      return "written";
    }
    return "skipped";
  }

  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
    if (force) {
      backupUnparseableConfig(dst);
      fs.writeFileSync(dst, JSON.stringify(fallback, null, 2) + "\n", "utf-8");
      return "written";
    }
    return "skipped";
  }

  const merged = mergeOpencodeConfig(existing as Record<string, unknown>);
  if (JSON.stringify(merged) === JSON.stringify(existing)) return "skipped";
  fs.writeFileSync(dst, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  return "written";
}

/** install: 落盘, 返回 InstallResult。 */
async function install(ctx: InstallContext): Promise<InstallResult> {
  const projectDir = path.resolve(ctx.projectDir);
  const entries = collectManifestEntries();
  const writtenFiles: string[] = [];
  const skippedFiles: string[] = [];

  for (const e of entries) {
    const dst = path.join(projectDir, e.rel);

    if (e.kind === "config") {
      const r = installConfig(dst, ctx.force);
      (r === "written" ? writtenFiles : skippedFiles).push(e.rel);
      continue;
    }

    // copy / agent 类都需要源文件存在
    if (!fs.existsSync(e.src)) {
      skippedFiles.push(e.rel);
      continue;
    }

    const r =
      e.kind === "agent"
        ? writeAgent(e.src, dst, ctx.force)
        : copyOne(e.src, dst, ctx.force);
    (r === "written" ? writtenFiles : skippedFiles).push(e.rel);
  }

  const manifest: AssetManifest = {
    files: entries.map((e) => ({
      path: e.rel,
      source: e.source,
      size: entrySize(e),
    })),
    conflictFiles: detectConflicts(projectDir, entries, ctx.force),
  };

  return { writtenFiles, skippedFiles, manifest };
}

/**
 * uninstall: 只删本工具装的, 不动用户其它文件。
 * 删: .claude/skills/loop-engineering/ (整目录)、.opencode/agents/<4 files>.md、.opencode/opencode.json。
 * 不删 .opencode/agents/ 目录本身 (保留用户自建 agent), 也不动 .claude/agents/ (那是 CC 的)。
 */
async function uninstall(projectDir: string): Promise<UninstallResult> {
  const root = path.resolve(projectDir);
  const removedFiles: string[] = [];
  const notFoundFiles: string[] = [];

  const rmDirIfExists = (abs: string, rel: string): void => {
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

  const rmFileIfExists = (abs: string, rel: string): void => {
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
  };

  // 1. .claude/skills/loop-engineering/ (整目录; 与 CC 共享, 但本工具装的内容一致, uninstall 清掉)
  rmDirIfExists(
    path.join(root, ".claude/skills/loop-engineering"),
    ".claude/skills/loop-engineering/",
  );

  // 2. .opencode/agents/ 下本工具装的 4 个文件 (只删本工具装的, 不删目录里用户自建 agent)
  const core = path.join(repoRoot(), "core");
  for (const f of listSubagents(core)) {
    rmFileIfExists(
      path.join(root, ".opencode/agents", f),
      `.opencode/agents/${f}`,
    );
  }

  // 3. .opencode/plugins/loop-engineering.js (本工具装的 plugin; 只删本文件, 不删目录里用户自建 plugin)
  rmFileIfExists(
    path.join(root, ".opencode/plugins/loop-engineering.js"),
    ".opencode/plugins/loop-engineering.js",
  );

  // 4. .opencode/opencode.json (整文件; 由本工具管理)
  rmFileIfExists(
    path.join(root, ".opencode/opencode.json"),
    ".opencode/opencode.json",
  );

  return { removedFiles, notFoundFiles };
}

/** OpenCode adapter 单例。 */
export const opencodeAdapter: HostAdapter = {
  host: "opencode",
  targetDir: ".opencode",
  install,
  dryRun,
  uninstall,
};

export { collectManifestEntries, repoRoot };
