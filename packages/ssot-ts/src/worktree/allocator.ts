/**
 * Run-level git worktree allocator.
 *
 * 一期只把一个 run 绑定到一个物理 worktree。默认 mode=auto 使用隔离 worktree;
 * 显式 mode=none 才保留旧 runDir 与 worker packet 工作目录。
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  WORKTREE_BINDING_OWNER,
  WORKTREE_BINDING_SCHEMA,
  type WorktreeBinding,
} from "./binding.js";

export type WorktreeMode = "none" | "auto" | "always" | "adopt";

export type GitRunner = (args: readonly string[], cwd: string) => string;

export interface WorktreeAllocationOptions {
  readonly mode: WorktreeMode;
  readonly repoCwd: string;
  readonly runId: string;
  readonly worktreeRoot?: string;
  readonly worktreePath?: string;
  readonly branchPrefix?: string;
  readonly baseRef?: string;
  readonly requirementSlug?: string;
  readonly git?: GitRunner;
  readonly now?: Date;
}

export interface WorktreeAllocation {
  readonly repoRoot: string;
  readonly workdir: string;
  readonly runsRoot: string;
  readonly binding: WorktreeBinding | null;
}

const DEFAULT_WORKTREE_ROOT = ".worktrees";
const DEFAULT_BRANCH_PREFIX = "loop/";
const DEFAULT_BASE_REF = "HEAD";

function defaultGit(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function normalizeAbs(p: string): string {
  return path.resolve(p);
}

function samePath(a: string, b: string): boolean {
  const left = normalizeAbs(a);
  const right = normalizeAbs(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function resolveMaybeRelative(raw: string, cwd: string): string {
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd, raw);
}

function slugify(raw: string | undefined): string {
  const slug = (raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "run";
}

function gitOutput(git: GitRunner, cwd: string, args: readonly string[]): string {
  return git(args, cwd).trim();
}

function repoRootFor(cwd: string, git: GitRunner): string {
  const out = gitOutput(git, cwd, ["rev-parse", "--show-toplevel"]);
  if (!out) throw new Error(`无法解析 git repo root: ${cwd}`);
  return path.resolve(out);
}

function commonGitDirFor(cwd: string, git: GitRunner): string {
  const out = gitOutput(git, cwd, ["rev-parse", "--git-common-dir"]);
  if (!out) throw new Error(`无法解析 git common dir: ${cwd}`);
  return resolveMaybeRelative(out, cwd);
}

function isLinkedWorktree(cwd: string, git: GitRunner): boolean {
  try {
    const root = repoRootFor(cwd, git);
    const dotGit = path.join(root, ".git");
    return fs.existsSync(dotGit) && fs.statSync(dotGit).isFile();
  } catch {
    return false;
  }
}

function assertWorktreeRootIgnored(repoRoot: string, worktreeRoot: string): void {
  const relative = path.relative(repoRoot, worktreeRoot).split(path.sep).join("/");
  if (relative.startsWith("..") || path.isAbsolute(relative)) return;

  const gitignore = path.join(repoRoot, ".gitignore");
  if (!fs.existsSync(gitignore)) {
    throw new Error(`worktree root ${relative}/ 未被 .gitignore 覆盖; 请先添加 ${relative}/`);
  }
  const lines = fs
    .readFileSync(gitignore, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const accepted = new Set([relative, `${relative}/`, `/${relative}`, `/${relative}/`]);
  if (!lines.some((line) => accepted.has(line))) {
    throw new Error(`worktree root ${relative}/ 未被 .gitignore 覆盖; 请先添加 ${relative}/`);
  }
}

function copyDirIfExists(src: string, dst: string): void {
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dst, { recursive: true, force: true });
}

/**
 * 从 settings.json 的 hooks 结构里收集所有 command 字符串。
 *
 * 形状: `{ <Event>: [ { hooks: [ { command: string } ] } ] }`。任何层级缺失/类型不符都
 * 静默跳过 (settings.json 可能是别的工具写的, 不归我们管)。
 */
function collectHookCommands(settings: unknown): string[] {
  const commands: string[] = [];
  if (typeof settings !== "object" || settings === null) return commands;
  const hooks = (settings as Record<string, unknown>).hooks;
  if (typeof hooks !== "object" || hooks === null) return commands;
  for (const matchers of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      if (typeof matcher !== "object" || matcher === null) continue;
      const inner = (matcher as Record<string, unknown>).hooks;
      if (!Array.isArray(inner)) continue;
      for (const entry of inner) {
        if (typeof entry !== "object" || entry === null) continue;
        const command = (entry as Record<string, unknown>).command;
        if (typeof command === "string") commands.push(command);
      }
    }
  }
  return commands;
}

// 本地 .mjs 模式: command 内含 `.claude/hooks/loop_engineering/<name>.mjs` 相对路径。
// CLI 模式 (形如 `e2e-loop hook <name>`) 不含此路径, 不被匹配, 因此天然跳过文件校验。
const LOCAL_MJS_HOOK_RE = /(\.claude\/hooks\/loop_engineering\/[A-Za-z0-9_.-]+\.mjs)/;

/**
 * 校验 worktree 内 hook 装配一致性 (fail-closed)。
 *
 * 升级动机: 旧 `copyDirIfExists` 是盲拷贝 —— 源不存在就静默跳过, 会产出"settings.json 注册了
 * hook 但 .mjs 缺失"的坏 worktree (hook 运行时 MODULE_NOT_FOUND 崩溃, 门失效)。这里在拷贝后
 * 复核: 凡 settings.json 引用了本地 .mjs hook 但对应文件不在 worktree → throw 中止 allocation。
 *
 * 兼容性: settings.json 不存在/解析失败 → 直接 return (没装 loop, 不归我们管); CLI 模式命令
 * (不含 .mjs 路径) → 跳过 (无 per-worktree 文件依赖)。
 */
function assertHookAssetsConsistent(worktreePath: string): void {
  const settingsPath = path.join(worktreePath, ".claude", "settings.json");
  if (!fs.existsSync(settingsPath)) return;

  let settings: unknown;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch {
    // 解析失败不归我们管, 保持兼容, 不 throw。
    return;
  }

  for (const command of collectHookCommands(settings)) {
    const match = LOCAL_MJS_HOOK_RE.exec(command);
    if (!match) continue; // 非本地 .mjs 模式 (CLI 模式等), 无文件依赖, 跳过。
    const rel = match[1]!;
    if (!fs.existsSync(path.join(worktreePath, rel))) {
      throw new Error(
        `worktree hook 装配不一致: settings.json 引用了 ${rel} 但文件缺失; ` +
          `主仓可能未安装/构建 loop 资产(先跑 e2e-loop install --host cc),拒绝产出无门 worktree。`,
      );
    }
  }
}

function syncProjectHookConfig(repoRoot: string, worktreePath: string): void {
  copyDirIfExists(path.join(repoRoot, ".claude"), path.join(worktreePath, ".claude"));
  copyDirIfExists(path.join(repoRoot, ".opencode"), path.join(worktreePath, ".opencode"));
  // 拷贝完成后做 fail-closed 校验: 拒绝产出"注册了 hook 但 .mjs 缺失"的坏 worktree。
  assertHookAssetsConsistent(worktreePath);
}

function makeBinding(fields: {
  mode: WorktreeBinding["mode"];
  repoRoot: string;
  worktreePath: string;
  branch: string | null;
  baseRef: string;
  managed: boolean;
  now: Date;
}): WorktreeBinding {
  return {
    schema: WORKTREE_BINDING_SCHEMA,
    mode: fields.mode,
    owner: WORKTREE_BINDING_OWNER,
    repo_root: fields.repoRoot,
    worktree_path: fields.worktreePath,
    branch: fields.branch,
    base_ref: fields.baseRef,
    created_at: fields.now.toISOString(),
    managed: fields.managed,
    status: "active",
  };
}

function allocateCreated(opts: WorktreeAllocationOptions, git: GitRunner): WorktreeAllocation {
  const repoRoot = repoRootFor(opts.repoCwd, git);
  const baseRef = opts.baseRef ?? DEFAULT_BASE_REF;
  const branchPrefix = opts.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
  const rawWorktreeRoot = opts.worktreeRoot ?? DEFAULT_WORKTREE_ROOT;
  const worktreeRoot = resolveMaybeRelative(rawWorktreeRoot, repoRoot);
  assertWorktreeRootIgnored(repoRoot, worktreeRoot);

  const worktreePath = opts.worktreePath
    ? path.resolve(opts.worktreePath)
    : path.join(worktreeRoot, opts.runId);
  if (fs.existsSync(worktreePath)) {
    throw new Error(`worktree path 已存在: ${worktreePath}`);
  }

  const branch = `${branchPrefix}${opts.runId}-${slugify(opts.requirementSlug)}`;
  git(["worktree", "add", worktreePath, "-b", branch, baseRef], repoRoot);
  syncProjectHookConfig(repoRoot, worktreePath);

  const binding = makeBinding({
    mode: "created",
    repoRoot,
    worktreePath,
    branch,
    baseRef,
    managed: true,
    now: opts.now ?? new Date(),
  });
  return {
    repoRoot,
    workdir: worktreePath,
    runsRoot: path.join(worktreePath, "runs"),
    binding,
  };
}

function allocateAdopted(opts: WorktreeAllocationOptions, git: GitRunner): WorktreeAllocation {
  if (!opts.worktreePath) {
    throw new Error("--worktree-mode adopt 需要 --worktree-path <path>");
  }
  const repoRoot = repoRootFor(opts.repoCwd, git);
  const adopted = path.resolve(opts.worktreePath);
  if (!fs.existsSync(adopted) || !fs.statSync(adopted).isDirectory()) {
    throw new Error(`adopt worktree 不存在或不是目录: ${adopted}`);
  }
  const sourceCommon = commonGitDirFor(repoRoot, git);
  const adoptedCommon = commonGitDirFor(adopted, git);
  if (!samePath(sourceCommon, adoptedCommon)) {
    throw new Error("adopt worktree 与当前 repo 不属于同一个 git common dir");
  }
  syncProjectHookConfig(repoRoot, adopted);
  const baseRef = opts.baseRef ?? DEFAULT_BASE_REF;
  const binding = makeBinding({
    mode: "adopted",
    repoRoot,
    worktreePath: adopted,
    branch: null,
    baseRef,
    managed: false,
    now: opts.now ?? new Date(),
  });
  return {
    repoRoot,
    workdir: adopted,
    runsRoot: path.join(adopted, "runs"),
    binding,
  };
}

export function allocateRunWorktree(opts: WorktreeAllocationOptions): WorktreeAllocation {
  const git = opts.git ?? defaultGit;
  const repoCwd = path.resolve(opts.repoCwd);

  if (opts.mode === "none") {
    return {
      repoRoot: repoCwd,
      workdir: repoCwd,
      runsRoot: path.join(repoCwd, "runs"),
      binding: null,
    };
  }

  if (opts.mode === "adopt") {
    return allocateAdopted({ ...opts, repoCwd }, git);
  }

  if (opts.mode === "auto" && isLinkedWorktree(repoCwd, git)) {
    const repoRoot = repoRootFor(repoCwd, git);
    const baseRef = opts.baseRef ?? DEFAULT_BASE_REF;
    const binding = makeBinding({
      mode: "existing",
      repoRoot,
      worktreePath: repoRoot,
      branch: null,
      baseRef,
      managed: false,
      now: opts.now ?? new Date(),
    });
    return {
      repoRoot,
      workdir: repoRoot,
      runsRoot: path.join(repoRoot, "runs"),
      binding,
    };
  }

  return allocateCreated({ ...opts, repoCwd }, git);
}

export function cleanupManagedWorktree(
  binding: WorktreeBinding,
  opts?: { git?: GitRunner },
): WorktreeBinding {
  if (binding.owner !== WORKTREE_BINDING_OWNER) {
    throw new Error(`cleanup 拒绝非 ${WORKTREE_BINDING_OWNER} binding`);
  }
  if (!binding.managed) {
    throw new Error("cleanup 拒绝 managed=false 的 worktree");
  }
  if (binding.status !== "active") {
    throw new Error(`cleanup 仅处理 active binding (当前 ${binding.status})`);
  }
  const git = opts?.git ?? defaultGit;
  const list = git(["worktree", "list", "--porcelain"], binding.repo_root);
  const owned = list
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length).trim()))
    .some((p) => samePath(p, binding.worktree_path));
  if (!owned) {
    throw new Error("cleanup 拒绝删除未出现在 git worktree list 中的路径");
  }
  const dirty = git(["status", "--porcelain"], binding.worktree_path);
  if (dirty.trim().length > 0) {
    throw new Error("cleanup 拒绝删除 dirty worktree");
  }
  git(["worktree", "remove", binding.worktree_path], binding.repo_root);
  return { ...binding, status: "cleaned" };
}
