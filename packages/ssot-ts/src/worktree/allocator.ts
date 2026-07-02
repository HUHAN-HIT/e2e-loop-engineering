/**
 * Run-level git worktree allocator.
 *
 * 一期只把一个 run 绑定到一个物理 worktree。默认 mode=auto 使用隔离 worktree;
 * 显式 mode=none 才保留旧 runDir 与 worker packet 工作目录。
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { keepOnlyLoopHooks, readWorktreeMarker } from "@e2e-loop/shared";

import {
  WORKTREE_BINDING_OWNER,
  WORKTREE_BINDING_SCHEMA,
  type WorktreeBinding,
} from "./binding.js";
import { writeWorktreeMarker } from "./marker.js";

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

/**
 * bootstrap 面包屑: 关键步骤前写一行 stderr。
 *
 * 动机: 原生层的 fast-fail 崩溃 (如 cpSync 在非 ASCII 路径, nodejs/node#54476) 会零输出、
 * 绕过 try/catch 与 --report-on-fatalerror。逐步留面包屑后, 即使进程被 fast-fail 直接干掉,
 * 用户也能从"最后一行 [bootstrap]"看出崩在哪一步。默认开 (bootstrap 一次性、行数极少);
 * 设环境变量 E2E_LOOP_NO_TRACE 可静音。
 */
export function bootstrapTrace(step: string): void {
  if (process.env.E2E_LOOP_NO_TRACE) return;
  process.stderr.write(`[bootstrap] ${step}\n`);
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
  copyDirRecursive(src, dst);
}

/**
 * 手写递归目录拷贝 (覆盖式, 等价 cpSync {recursive:true, force:true})。
 *
 * 为什么不用 fs.cpSync: Node v25 的 cpSync 在非 ASCII (如中文) 路径下"两条码路都坏":
 *   - 原生 C++ 快路径 → STATUS_STACK_BUFFER_OVERRUN 进程级崩溃 (nodejs/node#54476);
 *   - 传 filter 改走 JS 实现后, overwrite 时的 unlink 又报 errno=0 ("操作成功却抛错")。
 * 而单个 fs 原语 (readdirSync/copyFileSync/mkdirSync/symlinkSync) 在非 ASCII 路径下均正常。
 * 故用原语组合替代整个 cpSync: 对 Node 版本 / 路径字符集 / dst 是否已存在都稳定。
 *
 * 关键: 普通文件走 copyFileSync —— 它以 O_TRUNC 打开目标原地覆盖, 不经 unlink, 天然躲开
 * 上面那个 unlink bug (即"已提交 .claude 被 worktree 检出后再覆盖"的场景)。
 * 语义对齐 cpSync 默认: 递归、覆盖已存在文件、符号链接按链接本身拷 (dereference:false)。
 */
function copyDirRecursive(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(s, d);
    } else if (entry.isSymbolicLink()) {
      // 符号链接: 拷链接本身而非目标 (对齐 cpSync 默认)。symlinkSync 不覆盖, 已存在先删。
      // (.claude 资产里通常没有符号链接, 此分支是防御性的。)
      fs.rmSync(d, { force: true });
      fs.symlinkSync(fs.readlinkSync(s), d);
    } else {
      // 普通文件: copyFileSync 原地覆盖 (等价 force:true), 不走 unlink。
      fs.copyFileSync(s, d);
    }
  }
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

/**
 * 把过滤后的 settings 写进 worktree 的 `.claude/settings.json` (原子覆盖)。
 *
 * 复用 directory.ts 的"同目录 tmp + rename"模式 (此处用裸 renameSync; 这是 allocation
 * 一次性写入, 不在杀软高频竞态路径上, 与 writeWorktreeMarker 的 atomicReplace 区分: marker
 * 是状态文件需重试, settings 是装配产物一次写定)。
 */
function writeWorktreeSettings(worktreePath: string, settings: unknown): void {
  const claudeDir = path.join(worktreePath, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const target = path.join(claudeDir, "settings.json");
  fs.writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

/**
 * 同步 worktree 的 loop 资产 (spec 改动①: worktree-only 隔离)。
 *
 * 旧行为是"盲抄主工程 .claude 整目录 + .opencode", 会把用户主工程的非 loop hook 一起带进
 * worktree, 隔离失效。新行为:
 *   1. 抄 `.claude` 整目录 —— skill/agent/hook .mjs 等资产带过去 (它们不影响 hook 触发);
 *   2. 但 worktree 的 settings.json 被替换为"只含 loop hook"的过滤版 (keepOnlyLoopHooks
 *      过滤主工程 settings), 剥掉用户自定义 hook → 隔离成立;
 *   3. 不抄 `.opencode` —— worktree-only 是 CC 形态, 避免把 OC plugin 误带入 CC worktree。
 *
 * 保留 assertHookAssetsConsistent (fail-closed: 拒绝产出"注册了 hook 但 .mjs 缺失"的坏 worktree)。
 */
function syncProjectHookConfig(repoRoot: string, worktreePath: string): void {
  // 1. 抄 .claude 整目录 (skill/agent/hook 资产), 不抄 .opencode。
  bootstrapTrace("同步 .claude 资产到 worktree (递归拷贝)");
  copyDirIfExists(path.join(repoRoot, ".claude"), path.join(worktreePath, ".claude"));

  // 2. 用过滤版覆盖 worktree settings: 只保留 loop hook, 剥掉用户主工程的其它 hook。
  //    读主工程 settings (而非刚抄进 worktree 的那份, 二者此刻内容相同), 解析失败/不存在则跳过
  //    (没有 settings 可过滤, 与 copyDirIfExists 的"源不存在静默跳过"一致)。
  const repoSettingsPath = path.join(repoRoot, ".claude", "settings.json");
  if (fs.existsSync(repoSettingsPath)) {
    let settings: unknown;
    try {
      settings = JSON.parse(fs.readFileSync(repoSettingsPath, "utf-8"));
    } catch {
      settings = undefined; // 解析失败不归我们管 (可能是用户的 JSON5/注释), 保留抄进去的原样。
    }
    if (settings !== undefined) {
      writeWorktreeSettings(worktreePath, keepOnlyLoopHooks(settings));
    }
  }

  // 3. fail-closed 校验: 拒绝产出"注册了 hook 但 .mjs 缺失"的坏 worktree。
  assertHookAssetsConsistent(worktreePath);
}

/**
 * 在 worktree 根写 marker, 但先核对既有 marker: 若根已绑定一个属于本 owner 且 run_id 不同的
 * marker → 拒绝 (机械兑现 "一个 worktree 一个 run", 对应 spec 2026-06-29-worktree-only-isolation
 * 改动③ 中 existing/adopt 分支缺失的防撞)。无既有 marker 或同 run_id → 正常写。
 *
 * 缺口 B 修复 (2026-06-30): created 之外的 existing/adopt 分支此前设了 workdir 却不写 marker,
 * 使 worktreeGate 因 readWorktreeMarker(cwd)=null 永久拒绝 dispatch/run。统一经本 helper 补写。
 */
function bindWorktreeMarker(worktreeRoot: string, runId: string, now: Date): void {
  bootstrapTrace("写 worktree marker");
  const existing = readWorktreeMarker(worktreeRoot);
  if (existing !== null && existing.run_id !== runId) {
    throw new Error(
      `worktree 根 ${worktreeRoot} 已绑定 run ${existing.run_id}; ` +
        `一个 worktree 只跑一个 run, 拒绝再绑定 ${runId}`,
    );
  }
  writeWorktreeMarker(worktreeRoot, runId, now);
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
  bootstrapTrace(`git worktree add ${worktreePath} (branch ${branch})`);
  git(["worktree", "add", worktreePath, "-b", branch, baseRef], repoRoot);
  // git worktree add 之后任何一步失败 (hook 装配/marker 绑定 throw), 都要回滚刚建出来的
  // worktree + 分支; 否则会留下"已注册但残缺 (无 marker/runs)"的孤儿 worktree, 使下次
  // init 撞 "worktree path 已存在", 逼用户手动 git worktree remove 才能重试。
  try {
    syncProjectHookConfig(repoRoot, worktreePath);
    // worktree-only 隔离: 在 worktree 根写 marker, 作为"当前是否在 loop worktree 内"的唯一判据来源。
    bindWorktreeMarker(worktreePath, opts.runId, opts.now ?? new Date());
  } catch (err) {
    // 回滚尽力而为: 单步失败不掩盖原始错误, 最终 rethrow err。
    try {
      git(["worktree", "remove", "--force", worktreePath], repoRoot);
    } catch {
      /* ignore */
    }
    try {
      git(["branch", "-D", branch], repoRoot);
    } catch {
      /* ignore */
    }
    try {
      git(["worktree", "prune"], repoRoot);
    } catch {
      /* ignore */
    }
    throw err;
  }

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
  // 缺口 B: adopt 也要写根 marker, 否则 worktreeGate 永久拒绝该 run 的 dispatch/run。
  bindWorktreeMarker(adopted, opts.runId, opts.now ?? new Date());
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
    // 缺口 B: existing 分支也要写根 marker, 否则 worktreeGate 永久拒绝该 run 的 dispatch/run。
    bindWorktreeMarker(repoRoot, opts.runId, opts.now ?? new Date());
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

/**
 * 解析 worktree 根目录绝对路径 (与 allocateCreated 内部一致: 相对 git 仓库根解析)。
 *
 * 供 CLI 在 worktree 模式下把 worktree 根纳入 run_id 序号源 (见 nextRunIdFromRoots):
 * worktree 模式的 run 目录写进 <worktree>/runs, 主仓 ./runs 永远空, 只扫它会永远撞 ...-001;
 * 改扫 worktree 根 (其下 created worktree 目录名即 run_id) 才能让序号前进。单独导出以复用
 * 同一套 repoRoot/worktreeRoot 解析, 避免 CLI 侧重复实现导致与 allocator 分叉。
 */
export function resolveWorktreeRoot(
  repoCwd: string,
  worktreeRoot?: string,
  git: GitRunner = defaultGit,
): string {
  const repoRoot = repoRootFor(path.resolve(repoCwd), git);
  const raw = worktreeRoot ?? DEFAULT_WORKTREE_ROOT;
  return resolveMaybeRelative(raw, repoRoot);
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
