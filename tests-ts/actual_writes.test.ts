/**
 * actual_writes 等价测试 (P1 go/no-go 门禁)。
 *
 * 行为权威: Python `tests/test_actual_writes.py` + `loop_engineering/scheduling/actual_writes.py`。
 * 被测实现: `packages/shared/src/actual_writes.ts`。
 *
 * ── 两套实现的形态差异 (关键, 必读) ──────────────────────────────────────────
 * Python 端 collect_actual_writes 用 `RunCapabilities(git_diff/fs_snapshot)` + 显式传入
 * before/after snapshot dict; take_fs_snapshot 主动遍历 workdir 生成快照。
 *
 * TS 端形态不同 (CLAUDE.md: TS hook 不直接信任 toolResponse, 只读 coordinator 预写文件):
 *  - tryGitDiff(repoRoot, baseRef): git diff + status 双管齐下, 失败返回 null (降级)。
 *  - tryFsSnapshot(runDir, taskId): 读 tasks/<id>/before.snapshot + after.snapshot 两个 JSON
 *    文件并对比 mtime_ns, 缺文件/坏 JSON 返回 null。等价于 Python collect_via_fs_snapshot,
 *    但快照由 coordinator 预写而非本函数遍历产生。
 *  - readSelfReport / extractPathsFromText: 从 summary.md + key-diffs.yaml 粗抓路径 (L3 兜底)。
 *  - computeActualWrites(runDir, taskId, sinceMarker?, repoRoot?): 三层优先级编排,
 *    sinceMarker 触发 L1 git, 快照文件存在触发 L2 fs, 否则 L3 self_report。
 *  - checkBoundary(actualPaths, allowedWritePaths, earlierWrittenPaths): 越界两层,
 *    内置 matchPath (Python 用注入的 path_overlap_fn), earlier 用 flat 数组 (Python 用 dict)。
 *
 * 移植策略: 保留 Python 用例的**行为意图**, 按 TS 形态搭夹具断言相同结果。
 * git 路径用真实临时 git 仓库 (git 可用), 比 Python monkeypatch 更强。
 * Python 用例名以 `[py: <name>]` 标注。
 */
import { test, expect } from "bun:test";
import {
  tryGitDiff,
  tryFsSnapshot,
  extractPathsFromText,
  readSelfReport,
  computeActualWrites,
  checkBoundary,
} from "@e2e-loop/shared";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

// ── 临时目录夹具 ────────────────────────────────────────────────────────────
const _tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  _tmpDirs.push(d);
  return d;
}
function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* Windows 杀软扫描偶发占用, 忽略清理失败 */
  }
}
// 测试结束统一清理 (bun:test 无内建 afterAll 钩子时, 每用例自清即可; 这里集中兜底)
function cleanup(): void {
  while (_tmpDirs.length) rmrf(_tmpDirs.pop()!);
}

/** 写一对 snapshot 文件到 runDir/tasks/<taskId>/ */
function writeSnapshots(
  runDir: string,
  taskId: string,
  before: Record<string, number> | null,
  after: Record<string, number> | null,
): void {
  const taskDir = path.join(runDir, "tasks", taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  if (before !== null) {
    fs.writeFileSync(path.join(taskDir, "before.snapshot"), JSON.stringify(before));
  }
  if (after !== null) {
    fs.writeFileSync(path.join(taskDir, "after.snapshot"), JSON.stringify(after));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// L2 fs snapshot 对比 (Python collect_via_fs_snapshot 系列)
// ═══════════════════════════════════════════════════════════════════════════

test("[py: test_fs_snapshot_detects_new_file] before 无 after 有 → 检测到", () => {
  const run = mkTmp("aw-newfile-");
  writeSnapshots(run, "T1", { "a.py": 1 }, { "a.py": 1, "new.py": 2 });
  const changed = tryFsSnapshot(run, "T1");
  expect(changed).not.toBeNull();
  expect(changed!).toContain("new.py");
});

test("[py: test_fs_snapshot_detects_modified_file] mtime 变化 → 检测到", () => {
  const run = mkTmp("aw-mod-");
  writeSnapshots(run, "T1", { "a.py": 1000 }, { "a.py": 2000 });
  const changed = tryFsSnapshot(run, "T1");
  expect(changed!).toContain("a.py");
});

test("[py: test_fs_snapshot_ignores_unchanged] mtime 未变 → 不在 changed", () => {
  const run = mkTmp("aw-same-");
  writeSnapshots(run, "T1", { "a.py": 5, "b.py": 9 }, { "a.py": 5, "b.py": 9 });
  const changed = tryFsSnapshot(run, "T1");
  expect(changed).toEqual([]);
});

test("[py: test_fs_snapshot_detects_deleted_file] 删除也算写过 (before 有 after 无)", () => {
  const run = mkTmp("aw-del-");
  writeSnapshots(run, "T1", { "gone.py": 1, "keep.py": 2 }, { "keep.py": 2 });
  const changed = tryFsSnapshot(run, "T1");
  expect(changed!).toContain("gone.py");
  expect(changed!).not.toContain("keep.py");
});

test("[行为] tryFsSnapshot 结果排序且去重 (新增+修改+删除一并)", () => {
  const run = mkTmp("aw-mix-");
  writeSnapshots(
    run,
    "T1",
    { "a.py": 1, "same.py": 5, "gone.py": 9 },
    { "a.py": 2, "same.py": 5, "new.py": 3 },
  );
  const changed = tryFsSnapshot(run, "T1");
  // a.py(改) gone.py(删) new.py(增), same.py 不变 → 排序输出
  expect(changed).toEqual(["a.py", "gone.py", "new.py"]);
});

test("[行为] tryFsSnapshot 缺快照文件 → null (调用方降级)", () => {
  const run = mkTmp("aw-missing-");
  expect(tryFsSnapshot(run, "NOPE")).toBeNull();
});

test("[行为] tryFsSnapshot 坏 JSON → null", () => {
  const run = mkTmp("aw-badjson-");
  const taskDir = path.join(run, "tasks", "T1");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "before.snapshot"), "{not json");
  fs.writeFileSync(path.join(taskDir, "after.snapshot"), "{}");
  expect(tryFsSnapshot(run, "T1")).toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════════
// L3 self report (Python worker_self_report / take_fs_snapshot 排噪音对应)
// ═══════════════════════════════════════════════════════════════════════════

test("[py: _extract_paths_from_text] 抓相对路径, 反斜杠归一化, 绝对路径剥前缀", () => {
  const got = [...extractPathsFromText("改了 a/b.py 与 c\\d.ts; 单文件 x.txt 忽略; /abs/e.py")].sort();
  // a/b.py, c/d.ts 抓到; 裸 x.txt (无分隔符) 不抓; /abs/e.py 前导 / 不在字符集 → abs/e.py
  expect(got).toEqual(["a/b.py", "abs/e.py", "c/d.ts"]);
});

test("[行为] readSelfReport 合并 summary.md + key-diffs.yaml 且排序去重", () => {
  const run = mkTmp("aw-self-");
  const td = path.join(run, "tasks", "T2");
  fs.mkdirSync(td, { recursive: true });
  fs.writeFileSync(path.join(td, "summary.md"), "wrote src/foo.py and lib/bar.ts");
  fs.writeFileSync(path.join(td, "key-diffs.yaml"), "files:\n  - pkg/baz.js\n  - src/foo.py\n");
  // src/foo.py 在两个文件都出现 → 去重
  expect(readSelfReport(run, "T2")).toEqual(["lib/bar.ts", "pkg/baz.js", "src/foo.py"]);
});

test("[py: take_fs_snapshot 排噪音的反面] self report 文本里的 __pycache__/.pyc 仍被字面抓 (排噪音是 fs 层职责)", () => {
  // 说明: Python take_fs_snapshot 在遍历层排除 __pycache__/.git/node_modules/*.pyc;
  // TS 对应排除逻辑在 shouldExcludeRelPath (fs 快照生成侧)。self_report 是文本粗抓,
  // 不承担排噪音 —— 这条锁定职责边界: extractPathsFromText 会抓到 __pycache__/x.pyc。
  const got = [...extractPathsFromText("noise __pycache__/x.pyc here")];
  expect(got).toContain("__pycache__/x.pyc");
});

test("[行为] readSelfReport 文件都不存在 → 空数组", () => {
  const run = mkTmp("aw-noself-");
  fs.mkdirSync(path.join(run, "tasks", "T3"), { recursive: true });
  expect(readSelfReport(run, "T3")).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// L1 git diff (Python collect_via_git_diff, 用真实临时 git 仓库)
// ═══════════════════════════════════════════════════════════════════════════

function initGitRepo(): string {
  const repo = mkTmp("aw-git-");
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "tester"]);
  execFileSync("git", ["-C", repo, "config", "commit.gpgsign", "false"]);
  return repo;
}

test("[py: collect_via_git_diff] git diff + status 抓到 modified 与 untracked", () => {
  const repo = initGitRepo();
  fs.writeFileSync(path.join(repo, "committed.py"), "x=1");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"]);
  // 改已提交文件 + 新增 untracked
  fs.writeFileSync(path.join(repo, "committed.py"), "x=2");
  fs.writeFileSync(path.join(repo, "untracked.py"), "y=1");
  const writes = tryGitDiff(repo, "HEAD");
  expect(writes).not.toBeNull();
  expect(writes!).toContain("committed.py"); // diff --diff-filter=ADMR 抓 modified
  expect(writes!).toContain("untracked.py"); // status --porcelain 抓 untracked
});

test("[行为] tryGitDiff 删除文件也算写过 (§3.4 写过判)", () => {
  const repo = initGitRepo();
  fs.writeFileSync(path.join(repo, "doomed.py"), "x=1");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"]);
  fs.rmSync(path.join(repo, "doomed.py"));
  const writes = tryGitDiff(repo, "HEAD");
  expect(writes!).toContain("doomed.py");
});

test("[py: test_collect_falls_back_when_git_collection_fails] 非 git 目录 → null (降级)", () => {
  const notRepo = mkTmp("aw-notgit-");
  expect(tryGitDiff(notRepo, "HEAD")).toBeNull();
});

test("[行为] tryGitDiff 干净仓库 → 空数组 (authoritative empty, 非 null)", () => {
  const repo = initGitRepo();
  fs.writeFileSync(path.join(repo, "f.py"), "x=1");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"]);
  // 工作树干净
  expect(tryGitDiff(repo, "HEAD")).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// computeActualWrites 三层优先级 (Python collect_actual_writes 系列)
// ═══════════════════════════════════════════════════════════════════════════

test("[py: test_collect_prefers_git_when_available] 有 sinceMarker + git 可用 → source=git, authoritative", async () => {
  const repo = initGitRepo();
  fs.writeFileSync(path.join(repo, "base.py"), "x=1");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"]);
  fs.writeFileSync(path.join(repo, "changed.py"), "y=1"); // untracked
  // runDir 任意; git 路径用 repoRoot 直接指向 repo
  const run = mkTmp("aw-caw-git-");
  // 即使 fs 快照存在, git 优先
  writeSnapshots(run, "T1", { "fs.py": 1 }, { "fs.py": 2 });
  const r = await computeActualWrites(run, "T1", "HEAD", repo);
  expect(r.source).toBe("git");
  expect(r.isAuthoritative).toBe(true);
  expect(r.paths).toContain("changed.py");
  expect(r.paths).not.toContain("fs.py"); // git 优先, 不落 fs 结果
});

test("[py: test_collect_falls_back_to_fs] 无 sinceMarker, 有快照 → source=fs, authoritative", async () => {
  const run = mkTmp("aw-caw-fs-");
  writeSnapshots(run, "T1", { "a.py": 1 }, { "a.py": 2 });
  const r = await computeActualWrites(run, "T1"); // 不传 sinceMarker → 跳过 git
  expect(r.source).toBe("fs");
  expect(r.isAuthoritative).toBe(true);
  expect(r.paths).toEqual(["a.py"]);
});

test("[py: test_collect_handles_missing_inputs_gracefully] git 采集失败 → 降级 fs", async () => {
  // sinceMarker 给了但 repoRoot 指向非 git 目录 → tryGitDiff 返回 null → 降级 fs
  const notRepo = mkTmp("aw-caw-degrade-");
  writeSnapshots(notRepo, "T1", { "a.py": 1 }, { "a.py": 2 });
  const r = await computeActualWrites(notRepo, "T1", "HEAD", notRepo);
  expect(r.source).toBe("fs");
  expect(r.isAuthoritative).toBe(true);
  expect(r.paths).toEqual(["a.py"]);
});

test("[py: test_collect_falls_back_to_worker_self_report] 无 git 无快照 → source=self_report, 非 authoritative", async () => {
  const run = mkTmp("aw-caw-self-");
  const td = path.join(run, "tasks", "T1");
  fs.mkdirSync(td, { recursive: true });
  fs.writeFileSync(path.join(td, "summary.md"), "touched x/y.py and a/b.ts");
  const r = await computeActualWrites(run, "T1"); // 无 sinceMarker, 无快照文件
  expect(r.source).toBe("self_report");
  expect(r.isAuthoritative).toBe(false);
  expect(r.paths).toEqual(["a/b.ts", "x/y.py"]);
});

test("[py: test_collect_self_report_default_empty] 三层全空 → self_report 空数组", async () => {
  const run = mkTmp("aw-caw-empty-");
  fs.mkdirSync(path.join(run, "tasks", "T1"), { recursive: true });
  const r = await computeActualWrites(run, "T1");
  expect(r.source).toBe("self_report");
  expect(r.paths).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 越界检测两层 (Python detect_out_of_bounds 系列)
// ═══════════════════════════════════════════════════════════════════════════

test("[py: test_detect_oob_no_oob] actual ⊆ allowed → 无越界", () => {
  const r = checkBoundary(["src/a.py", "src/b.py"], ["src/**"], []);
  expect(r.outOfBounds).toEqual([]);
  expect(r.collided).toEqual([]);
});

test("[py: test_detect_oob_finds_extra_path] actual 含 allowed 外路径 → 越界", () => {
  const r = checkBoundary(["src/a.py", "tests/x.py"], ["src/**"], []);
  expect(r.outOfBounds).toContain("tests/x.py");
  expect(r.outOfBounds).not.toContain("src/a.py");
});

test("[py: test_detect_oob_empty_actual_no_crash] actual=[] → 无越界, 不抛", () => {
  const r = checkBoundary([], ["src/**"], []);
  expect(r.outOfBounds).toEqual([]);
  expect(r.collided).toEqual([]);
});

test("[py: test_detect_oob_cross_task_shared_path] 已被更早 task 写过 → collided (归最早)", () => {
  // src/shared.py 在 allowed 内但已被更早 task 写过 → 层 2 越界
  const r = checkBoundary(["src/shared.py"], ["src/**"], ["src/shared.py"]);
  expect(r.collided).toContain("src/shared.py");
  expect(r.outOfBounds).toEqual([]); // 在 declared 内, 不算层 1 越界
});

test("[py: test_detect_oob_empty_declared_treats_all_as_oob] 空 allowed → 任何 actual 都越界", () => {
  const r = checkBoundary(["x.py"], [], []);
  expect(r.outOfBounds).toContain("x.py");
});

test("[行为] 层 1 优先于层 2: allowed 外的路径即使被更早写过, 也归 outOfBounds 不归 collided", () => {
  // tests/x.py 不在 src/** 内 → 层 1 越界, continue, 不进层 2 collided 判定
  const r = checkBoundary(["tests/x.py"], ["src/**"], ["tests/x.py"]);
  expect(r.outOfBounds).toContain("tests/x.py");
  expect(r.collided).toEqual([]);
});

test("[行为] 越界检测复用 matchPath: src/* 单层 allowed 不覆盖 src/deep/x.py", () => {
  // 回归: 修复后 src/* 不跨层, 故 src/deep/x.py 越界 (此前 bug 会误判在范围内)
  const r = checkBoundary(["src/deep/x.py"], ["src/*"], []);
  expect(r.outOfBounds).toContain("src/deep/x.py");
});

// ═══════════════════════════════════════════════════════════════════════════
// harness bootstrap 产物过滤 (治根: 不被 git status untracked 采进后误判越界)
// ═══════════════════════════════════════════════════════════════════════════

test("[行为] computeActualWrites 过滤 harness 产物, 只留真实源码 (.claude/runs/resume.* 不计入)", async () => {
  const repo = initGitRepo();
  // base commit: 把真实源码先纳入版本控制 (git status 对 untracked 目录会折叠成 "src/" 单条,
  // 故先 commit src/real.ts, 后续对它的修改才会以文件级路径出现在 diff/status 里)。
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "real.ts"), "export const x = 0;");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "base"]);

  // 制造改动: 3 类 harness 产物 (untracked) + 修改 1 个真实源码 (tracked)
  fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".claude", "settings.json"), "{}");
  fs.mkdirSync(path.join(repo, "runs", "r", "tasks", "t"), { recursive: true });
  fs.writeFileSync(path.join(repo, "runs", "r", "tasks", "t", "summary.md"), "done");
  fs.writeFileSync(path.join(repo, "resume.cmd"), "cd .");
  fs.writeFileSync(path.join(repo, "src", "real.ts"), "export const x = 1;");

  const run = mkTmp("aw-harness-filter-");
  const r = await computeActualWrites(run, "T1", "HEAD", repo);
  expect(r.source).toBe("git");
  // 只含真实源码, 不含任何 harness 产物
  expect(r.paths).toEqual(["src/real.ts"]);
  expect(r.paths.some((p) => p.startsWith(".claude/"))).toBe(false);
  expect(r.paths.some((p) => p.startsWith("runs/"))).toBe(false);
  expect(r.paths).not.toContain("resume.cmd");
});

test("[清理] 删除全部临时目录夹具", () => {
  cleanup();
  expect(_tmpDirs.length).toBe(0);
});
