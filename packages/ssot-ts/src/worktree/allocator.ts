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

function syncProjectHookConfig(repoRoot: string, worktreePath: string): void {
  copyDirIfExists(path.join(repoRoot, ".claude"), path.join(worktreePath, ".claude"));
  copyDirIfExists(path.join(repoRoot, ".opencode"), path.join(worktreePath, ".opencode"));
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
