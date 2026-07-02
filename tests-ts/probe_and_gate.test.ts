/**
 * probe_and_gate (Hook D / SessionStart) 等价测试。
 *
 * 行为权威: Python `loop_engineering/hooks/loop_engineering/probe_and_gate.py`
 * 用例源: Python `tests/test_hooks_smoke.py::TestProbeAndGate`
 *
 * TS ↔ Python decision 语义映射 (见 packages/shared/src/types.ts 注释):
 *   - TS decision="defer" (含 context) ↔ Python emit additionalContext (放行 + 注入)
 *   - TS decision="deny"               ↔ Python emit_block (拒绝, block)
 *   - TS decision="allow"              ↔ Python emit_pass_silent (静默放行)
 *
 * 隔离策略: 每个用例用独立 os.tmpdir() 临时目录作 repoRoot, 临时 runs/ 根,
 * 通过 LOOP_RUNS_ROOT 环境变量定位; 不同用例 runDir 不同, 避免任何串台。
 */

import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleProbeAndGate, type HookInput } from "@e2e-loop/shared";

// ---------------------------------------------------------------------------
// 临时夹具工具
// ---------------------------------------------------------------------------

/** 待清理的临时目录集合 (每个用例独立, afterEach 统一删) */
const _toClean: string[] = [];
const _envBackup = process.env.LOOP_RUNS_ROOT;

afterEach(() => {
  // 恢复环境变量, 防止用例间串台
  if (_envBackup === undefined) delete process.env.LOOP_RUNS_ROOT;
  else process.env.LOOP_RUNS_ROOT = _envBackup;
  while (_toClean.length) {
    const d = _toClean.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响断言 */
    }
  }
});

/** 创建一个独立的临时 repoRoot, 注册待清理。 */
function makeRepoRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-probe-${label}-`));
  _toClean.push(root);
  return root;
}

/**
 * 在 repoRoot 下建 runs/<runId>/ 并写 run-state.json, 设 LOOP_RUNS_ROOT 指向它。
 * 返回 runDir 绝对路径。
 */
function makeRun(
  repoRoot: string,
  runId: string,
  state: Record<string, unknown>,
): string {
  const runsRoot = path.join(repoRoot, "runs");
  const runDir = path.join(runsRoot, runId);
  fs.mkdirSync(path.join(runDir, "planning"), { recursive: true });
  fs.mkdirSync(path.join(runDir, "tasks"), { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "run-state.json"),
    JSON.stringify(state),
    "utf-8",
  );
  process.env.LOOP_RUNS_ROOT = runsRoot;
  return runDir;
}

/** 构造一个 SessionStart 的 HookInput。 */
function sessionStartInput(cwd: string): HookInput {
  return { event: "SessionStart", cwd };
}

// ---------------------------------------------------------------------------
// 用例 1: 无活跃 run + git/fs 可用 → defer; context.capabilities.git_diff=true
// (Python test_no_active_run_injects_capabilities)
// ---------------------------------------------------------------------------

test("无活跃 run → defer 并注入 capabilities (git 可用时 git_diff=true)", async () => {
  const repoRoot = makeRepoRoot("noactive");
  // 建空 runs 根 (无任何 run 子目录) → findActiveRun 返回 null
  const runsRoot = path.join(repoRoot, "runs");
  fs.mkdirSync(runsRoot, { recursive: true });
  process.env.LOOP_RUNS_ROOT = runsRoot;

  const out = await handleProbeAndGate(sessionStartInput(repoRoot));

  expect(out.decision).toBe("defer");
  expect(out.context).toBeDefined();
  const ctx = out.context!;
  expect(ctx.loop_engineering_session_start).toBe(true);
  expect(ctx.active_run).toBe(null);
  // capabilities 字段存在且含 git_diff (本机 git 可用 → true)
  const caps = ctx.capabilities as { git_diff: boolean; fs_snapshot: boolean };
  expect(caps).toBeDefined();
  expect(typeof caps.git_diff).toBe("boolean");
  expect(caps.git_diff).toBe(true); // 环境事实: git 可用
  expect(typeof caps.fs_snapshot).toBe("boolean");
});

// ---------------------------------------------------------------------------
// 用例 2: 无活跃 run → 永不 block, capabilities 形状校验
// (对应 Python "git_diff in caps" 断言; 即便缺依赖也只是 false, 绝不 block)
// ---------------------------------------------------------------------------

test("无活跃 run → 永不 block, capabilities 永远含 git_diff/fs_snapshot 两个布尔字段", async () => {
  const repoRoot = makeRepoRoot("capshape");
  const runsRoot = path.join(repoRoot, "runs");
  fs.mkdirSync(runsRoot, { recursive: true });
  process.env.LOOP_RUNS_ROOT = runsRoot;

  const out = await handleProbeAndGate(sessionStartInput(repoRoot));

  // 关键: 缺依赖也只退化为 false, 绝不 deny/锁会话
  expect(out.decision).not.toBe("deny");
  const caps = out.context!.capabilities as Record<string, unknown>;
  expect(Object.prototype.hasOwnProperty.call(caps, "git_diff")).toBe(true);
  expect(Object.prototype.hasOwnProperty.call(caps, "fs_snapshot")).toBe(true);
});

// ---------------------------------------------------------------------------
// 用例 3: 活跃 run + trust_mode=collaborative → defer; context.trust_mode="collaborative"
// (Python test_collaborative_active_run_injects)
// ---------------------------------------------------------------------------

test("活跃 run + collaborative → defer 注入 active_run/trust_mode (不 block)", async () => {
  const repoRoot = makeRepoRoot("collab");
  const runDir = makeRun(repoRoot, "20260101-001", {
    run_id: "20260101-001",
    phase: "IMPLEMENTING",
    complexity: "simple",
    trust_mode: "collaborative",
    active_tasks: ["t1"],
  });

  const out = await handleProbeAndGate(sessionStartInput(repoRoot));

  expect(out.decision).toBe("defer");
  const ctx = out.context!;
  expect(ctx.active_run).not.toBe(null);
  expect(ctx.active_run).toBe(runDir);
  expect(ctx.trust_mode).toBe("collaborative");
  expect(ctx.phase).toBe("IMPLEMENTING");
  // detected capabilities 注入
  expect(ctx.capabilities_detected).toBeDefined();
});

// ---------------------------------------------------------------------------
// 用例 4: 活跃 run + trust_mode=unattended → deny; reason 含 "unattended" 和 "§0.3"
// (Python test_unattended_without_replay_channel_blocks)
// ---------------------------------------------------------------------------

test("活跃 run + unattended 且通道未就绪 → deny, reason 含 unattended 与 §0.3", async () => {
  const repoRoot = makeRepoRoot("unattended");
  makeRun(repoRoot, "20260101-001", {
    run_id: "20260101-001",
    phase: "IMPLEMENTING",
    complexity: "simple",
    trust_mode: "unattended",
    active_tasks: ["t1"],
  });

  const out = await handleProbeAndGate(sessionStartInput(repoRoot));

  expect(out.decision).toBe("deny");
  const reason = out.reason ?? "";
  // Python 断言: "unattended" in reason 或 "§0.3" in reason; TS 实现两者都含
  expect(reason).toContain("unattended");
  expect(reason).toContain("§0.3");
});

// ---------------------------------------------------------------------------
// 用例 5: run 目录无 run-state.json → 退化为无活跃 run 分支 (不 block)
//
// 结构差异说明: Python active_run_dir 用 mtime 定位活跃 run (不读 state), 故能命中
// "active!=null 但 state==null → warning" 分支; TS findActiveRun 用 run-state.json
// 判活跃, run-state.json 缺失时 findActiveRun 直接返回 null → 走"无活跃 run"分支。
// 二者行为等价 (都不 block, 都注入 capabilities), 仅 context 字段不同。详见简报。
// ---------------------------------------------------------------------------

test("run 目录无 run-state.json → 不 block, 退化为无活跃 run", async () => {
  const repoRoot = makeRepoRoot("nostate");
  const runsRoot = path.join(repoRoot, "runs");
  const runDir = path.join(runsRoot, "20260101-001");
  fs.mkdirSync(path.join(runDir, "planning"), { recursive: true });
  process.env.LOOP_RUNS_ROOT = runsRoot;

  const out = await handleProbeAndGate(sessionStartInput(repoRoot));

  // 不 block; 退化为无活跃 run (active_run=null)
  expect(out.decision).toBe("defer");
  expect(out.decision).not.toBe("deny");
  expect(out.context!.active_run).toBe(null);
});

// ---------------------------------------------------------------------------
// 用例 5b: run-state.json 存在但 JSON 损坏 → findActiveRun 跳过 → 无活跃 run, 不 block
// ---------------------------------------------------------------------------

test("run-state.json 损坏 (非法 JSON) → 不 block, 退化为无活跃 run", async () => {
  const repoRoot = makeRepoRoot("brokenstate");
  const runsRoot = path.join(repoRoot, "runs");
  const runDir = path.join(runsRoot, "20260101-001");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "run-state.json"),
    "{ not valid json",
    "utf-8",
  );
  process.env.LOOP_RUNS_ROOT = runsRoot;

  const out = await handleProbeAndGate(sessionStartInput(repoRoot));

  // 损坏 state → readRunState 返回 null → findActiveRun 跳过 → 无活跃 run
  expect(out.decision).not.toBe("deny");
  expect(out.context!.active_run).toBe(null);
});

// ---------------------------------------------------------------------------
// 用例 6: 恶劣输入 (cwd 含 NUL 字节) → 不抛错、不锁会话 (退化放行精神)
//
// 实现说明: probe_and_gate 的所有 IO 都有内层 try/catch (probeCapabilities 内层吞错,
// findActiveRun 的 readdirSync 内层吞 ERR_INVALID_ARG_VALUE 返回 null)。因此恶劣 cwd
// 走到 "无活跃 run" 分支返回 defer —— 关键不变量是: handle 绝不向调用方抛异常, 也绝不
// 返回 deny 锁死会话。这正是 probe_and_gate fail-safe=放行 的语义 (与其它 hook 相反)。
// (顶层 catch → passSilent()/allow 的纯异常路径在当前健壮实现下黑盒不可达; 见简报。)
// ---------------------------------------------------------------------------

test("恶劣输入 (cwd 含 NUL 字节) → 不抛错、不 deny、不锁会话", async () => {
  const NUL = String.fromCharCode(0);
  const badCwd = `bad${NUL}path`;
  // 不设 LOOP_RUNS_ROOT, 让 resolveRunsRoot 走 path.join(badCwd, "runs")
  delete process.env.LOOP_RUNS_ROOT;

  let out;
  let threw = false;
  try {
    out = await handleProbeAndGate(sessionStartInput(badCwd));
  } catch {
    threw = true;
  }

  // 关键不变量: 绝不抛错 (不锁死会话)
  expect(threw).toBe(false);
  // 绝不 deny (probe_and_gate fail-safe = 放行, 不静默降级锁会话)
  expect(out!.decision).not.toBe("deny");
});

// ---------------------------------------------------------------------------
// 改动② (worktree-only): worktree 内一致性正向自检
//
// findActiveRun 拿到 active 后, 用 cwd 的根 marker (.loop-engineering/worktree.json)
// 校验 marker.run_id 与 active.runId 是否一致:
//   - 一致 / 无 marker → 维持现有注入, 不加 warning。
//   - 不一致 → 注入 warning (worktree 复用/状态错位提示)。
//   - 异常仍退化放行, 守红线 (沿用既有用例 6 覆盖)。
// ---------------------------------------------------------------------------

/** 在 repoRoot 根写一个合法 worktree marker (绑定 markerRunId)。 */
function writeCwdMarker(repoRoot: string, markerRunId: string): void {
  const markerPath = path.join(repoRoot, ".loop-engineering", "worktree.json");
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(
    markerPath,
    JSON.stringify({
      schema: "loop-engineering.worktree-marker.v1",
      owner: "loop-engineering",
      run_id: markerRunId,
      created_at: "2026-06-29T00:00:00.000Z",
    }),
    "utf-8",
  );
}

test("[改动②] cwd marker.run_id 与 active run 一致 → 正常注入, 无 worktree 错位 warning", async () => {
  const repoRoot = makeRepoRoot("wt-match");
  makeRun(repoRoot, "20260101-001", {
    run_id: "20260101-001",
    phase: "IMPLEMENTING",
    complexity: "simple",
    trust_mode: "collaborative",
    active_tasks: ["t1"],
  });
  // marker 与 active run 同 id
  writeCwdMarker(repoRoot, "20260101-001");

  const out = await handleProbeAndGate(sessionStartInput(repoRoot));

  expect(out.decision).toBe("defer");
  const ctx = out.context!;
  // 一致 → 不应有 worktree 错位 warning (warning 字段缺失或不含 worktree 错位语义)
  const w = ctx.worktree_marker_warning;
  expect(w === undefined || w === null).toBe(true);
  // 仍维持现有注入
  expect(ctx.trust_mode).toBe("collaborative");
});

test("[改动②] cwd marker.run_id 与 active run 不一致 → 注入 worktree 错位 warning", async () => {
  const repoRoot = makeRepoRoot("wt-mismatch");
  makeRun(repoRoot, "20260101-002", {
    run_id: "20260101-002",
    phase: "IMPLEMENTING",
    complexity: "simple",
    trust_mode: "collaborative",
    active_tasks: ["t1"],
  });
  // marker 绑定的是另一个 run
  writeCwdMarker(repoRoot, "20251231-009");

  const out = await handleProbeAndGate(sessionStartInput(repoRoot));

  // 不锁死会话 (仍 defer, 不 deny)
  expect(out.decision).toBe("defer");
  expect(out.decision).not.toBe("deny");
  const ctx = out.context!;
  // 应注入 worktree marker 错位 warning
  expect(typeof ctx.worktree_marker_warning).toBe("string");
  expect(String(ctx.worktree_marker_warning)).toContain("20251231-009");
});

test("[改动②] cwd 无 marker → 维持现有行为 (无 worktree 错位 warning)", async () => {
  const repoRoot = makeRepoRoot("wt-nomarker");
  makeRun(repoRoot, "20260101-003", {
    run_id: "20260101-003",
    phase: "IMPLEMENTING",
    complexity: "simple",
    trust_mode: "collaborative",
    active_tasks: ["t1"],
  });
  // 不写 marker

  const out = await handleProbeAndGate(sessionStartInput(repoRoot));

  expect(out.decision).toBe("defer");
  const ctx = out.context!;
  const w = ctx.worktree_marker_warning;
  expect(w === undefined || w === null).toBe(true);
  expect(ctx.active_run).not.toBe(null);
});
