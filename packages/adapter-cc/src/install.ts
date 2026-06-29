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
import { toDashHookName } from "./hook_dispatcher.js";

/** 4 个 hook 的逻辑名 (与 HookName 对齐; 与 .mjs 文件名 1:1)。 */
const HOOK_NAMES = [
  "probe_and_gate",
  "guard_paths",
  "post_task_collect",
  "guard_anchors",
] as const;
type ClaudeHookMode = "local" | "cli";

const DEFAULT_CLI_COMMAND = "e2e-loop";

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function resolveClaudeHookMode(ctx?: InstallContext): ClaudeHookMode {
  if (ctx?.hookMode === "cli") return "cli";
  if (ctx?.hookMode === "auto" && ctx.cliCommand) return "cli";
  return "local";
}

function commandForHook(name: (typeof HOOK_NAMES)[number], ctx?: InstallContext): string {
  if (resolveClaudeHookMode(ctx) === "cli") {
    const cliCommand = ctx?.cliCommand?.trim() || DEFAULT_CLI_COMMAND;
    return `${cliCommand} hook ${toDashHookName(name)}`;
  }
  return `node .claude/hooks/loop_engineering/${name}.mjs`;
}

function renderSettings(ctx?: InstallContext): Record<string, unknown> {
  const rendered = cloneJson(settingsTemplate) as Record<string, unknown>;
  const hooks = rendered.hooks as Record<string, Array<Record<string, unknown>>>;
  const specs: Array<{ event: string; hook: (typeof HOOK_NAMES)[number] }> = [
    { event: "SessionStart", hook: "probe_and_gate" },
    { event: "PreToolUse", hook: "guard_paths" },
    { event: "PostToolUse", hook: "post_task_collect" },
    { event: "Stop", hook: "guard_anchors" },
  ];
  for (const spec of specs) {
    const group = hooks[spec.event]?.[0];
    const hookEntries = group?.hooks as Array<Record<string, unknown>> | undefined;
    if (hookEntries?.[0]) {
      hookEntries[0].command = commandForHook(spec.hook, ctx);
    }
  }
  return rendered;
}

const LOOP_ENGINEERING_CLI_HOOK_RE =
  /\bhook\s+(probe-and-gate|probe_and_gate|guard-paths|guard_paths|post-task-collect|post_task_collect|guard-anchors|guard_anchors)(\s|$)/;

function isLoopEngineeringHookCommand(command: string): boolean {
  const normalized = command.replaceAll("\\", "/");
  if (normalized.includes(".claude/hooks/loop_engineering/")) return true;
  if (!LOOP_ENGINEERING_CLI_HOOK_RE.test(normalized)) return false;
  return /(^|\s)e2e-loop(\s|$)/.test(normalized) || /^node\s+/i.test(normalized);
}

function stripLoopEngineeringHooks(groups: unknown): unknown[] {
  if (!Array.isArray(groups)) return [];
  const keptGroups: unknown[] = [];
  for (const group of groups as Array<Record<string, unknown>>) {
    const hookEntries = Array.isArray(group?.hooks) ? group.hooks : [];
    const keptHooks = hookEntries.filter((hook) => {
      const command = (hook as Record<string, unknown>)?.command;
      return typeof command !== "string" || !isLoopEngineeringHookCommand(command);
    });
    if (keptHooks.length > 0) {
      keptGroups.push({ ...group, hooks: keptHooks });
    }
  }
  return keptGroups;
}

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
 *   2. node 跑构建后的 packages/cli/dist/index.js (install.ts 被 tsup 打进 CLI bundle):
 *      import.meta.url = packages/cli/dist/index.js, 同样逐级向上能命中仓库根。
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
      size = Buffer.byteLength(JSON.stringify(renderSettings(ctx)), "utf-8");
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
  ctx: InstallContext,
): "written" | "skipped" {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const incoming = renderSettings(ctx);
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
    // 用户 settings 不可解析 (如 JSON5 注释 / 手写残缺): force 覆盖前先备份, 避免破坏用户原始配置。
    // 备份命名: settings.json.loop-engineering.bak (与原文件同目录, 用户可肉眼看到并手动恢复)。
    if (force) {
      backupUnparseableSettings(dst);
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
      backupUnparseableSettings(dst);
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

/**
 * 备份用户不可解析的 settings.json (force=true 覆盖前的保护)。
 *
 * 命名: settings.json.loop-engineering.bak (与原文件同目录, 用户可肉眼看到并手动恢复)。
 * 失败不抛 (备份是 best-effort 保护, 不应阻塞主流程), 仅 stderr 提示。
 */
function backupUnparseableSettings(dst: string): void {
  try {
    const bak = `${dst}.loop-engineering.bak`;
    fs.copyFileSync(dst, bak);
    process.stderr.write(
      `[loop-engineering] 用户 settings.json 不可解析, 已备份至 ${bak} 后覆盖。\n`,
    );
  } catch (e) {
    process.stderr.write(
      `[loop-engineering] settings.json 备份失败 (best-effort 跳过): ${
        e instanceof Error ? e.message : String(e)
      }\n`,
    );
  }
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
  for (const [event, groups] of Object.entries(newHooks)) {
    newHooks[event] = stripLoopEngineeringHooks(groups);
  }
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
      const r = installSettings(dst, ctx.force, ctx);
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
        size = Buffer.byteLength(JSON.stringify(renderSettings(ctx)), "utf-8");
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
 * settings.json 中本工具注入的 hooks 条目 (保留用户其它配置; 与 install 的 mergeHooks 对称)。
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

  // 4. settings.json: 只删本工具注入的 hooks 条目 (与 install 的 mergeHooks 对称),
  // 保留用户其它配置 (其它 hooks / permissions / env 等)。文件解析失败/非 object 时
  // **不动用户文件** (避免破坏非标 JSON5/注释配置)。
  const settingsAbs = path.join(root, ".claude/settings.json");
  if (!fs.existsSync(settingsAbs)) {
    notFoundFiles.push(".claude/settings.json");
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(settingsAbs, "utf-8"));
    } catch {
      // 用户 settings.json 不可解析 (例如含注释/JSON5): 不动文件, 仅标 notFound
      // (避免覆盖抹掉用户原始配置)。
      notFoundFiles.push(".claude/settings.json");
      parsed = undefined;
    }
    if (parsed !== undefined) {
      if (typeof parsed !== "object" || parsed === null) {
        // 顶层非 object: 不是合法 settings, 不动。
        notFoundFiles.push(".claude/settings.json");
      } else {
        const obj = parsed as Record<string, unknown>;
        // obj.hooks 形状: { <EventName>: Array<Group> } (与 mergeHooks 一致)。
        // stripLoopEngineeringHooks 接受单个 event 的 groups 数组, 故按 event 遍历,
        // 不再误把整个 obj.hooks 对象当成数组传入 (会丢用户配置)。
        const next: Record<string, unknown> = { ...obj };
        if (
          typeof obj.hooks === "object" &&
          obj.hooks !== null &&
          !Array.isArray(obj.hooks)
        ) {
          const hooksObj = obj.hooks as Record<string, unknown>;
          const newHooks: Record<string, unknown> = {};
          let anyKept = false;
          for (const [event, groups] of Object.entries(hooksObj)) {
            const kept = stripLoopEngineeringHooks(groups);
            if (kept.length > 0) {
              newHooks[event] = kept;
              anyKept = true;
            }
          }
          if (anyKept) {
            next.hooks = newHooks;
          } else {
            delete next.hooks;
          }
        } else {
          delete next.hooks;
        }
        try {
          fs.writeFileSync(
            settingsAbs,
            JSON.stringify(next, null, 2) + "\n",
            "utf-8",
          );
          removedFiles.push(".claude/settings.json");
        } catch {
          notFoundFiles.push(".claude/settings.json");
        }
      }
    }
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
