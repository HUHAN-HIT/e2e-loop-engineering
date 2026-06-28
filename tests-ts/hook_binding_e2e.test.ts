/**
 * Hook binding 端到端回归 (publish 前的最后一道门禁)。
 *
 * 与现有测试的差别:
 *   - hook logic 单测 (probe_and_gate.test.ts 等): 直接 import handle*, 验证决策对象。
 *   - install_e2e.test.ts: 只断言 4 个 .mjs 落盘且非空, 不验证它们真实执行行为。
 *   - 本测试: spawn `node .claude/hooks/loop_engineering/<name>.mjs` 子进程, 喂真实 CC
 *     stdin JSON, 解析真实 stdout, 验证 4 个 hook 在【打包 + 真实 stdin/stdout 协议】下
 *     的决策正确。这是真发 npm 前封住 "logic 绿、bundle 形态坏" 盲区的最后一道门禁。
 *
 * CC hook 协议 (行为权威: packages/adapter-cc/src/runtime.ts):
 *   - stdin:  JSON { hook_event_name, cwd, tool_name?, tool_input?, tool_response? }
 *   - stdout:
 *       allow → 空字符串
 *       deny  → {"decision":"block","reason":"..."}
 *       defer → {"hookSpecificOutput":{"additionalContext":"<JSON 字符串>"}}
 *
 * 覆盖矩阵 (8 用例):
 *   probe_and_gate (SessionStart):
 *     1. 无活跃 run       → defer; additionalContext 解析后含 capabilities.git_diff
 *     2. 活跃 run + unattended 无通道 → deny block; reason 含 "unattended"
 *   guard_paths (PreToolUse Write):
 *     3. IMPLEMENTING + allowed=["src/**"] + 写 src/a.ts → allow (stdout 空)
 *     4. 同上下文 + 写 .claude/settings.json → deny block (永远 deny 区)
 *     5. 同上下文 + 写 docs/x.md (OOB)              → deny block
 *   guard_anchors (Stop):
 *     6. phase=COMPLETE → allow
 *     7. phase=ABORTED  → allow
 *   post_task_collect (PostToolUse Task):
 *     8a. 非 loop-engineering worker (如 general-purpose) → 放行 (不干扰宿主原生 Task)
 *     8b. LE worker (implementation-worker) + 无活跃 run → deny block (worker 跑了但没 init)
 */
import { test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { fileURLToPath } from "node:url";
import { execSync, execFileSync, spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// 仓库根定位 (照 install_e2e.test.ts 同款判据)
// ---------------------------------------------------------------------------

function resolveRepoRoot(): string {
  const candidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    process.cwd(),
  ];
  for (const c of candidates) {
    if (
      fs.existsSync(path.join(c, "core", "manifest.json")) &&
      fs.existsSync(path.join(c, "packages", "adapter-cc"))
    ) {
      return c;
    }
  }
  throw new Error(`无法定位仓库根 (尝试: ${candidates.join(", ")})`);
}

const REPO_ROOT = resolveRepoRoot();
const CLI_BUNDLE = path.join(REPO_ROOT, "packages", "cli", "dist", "index.mjs");

// ---------------------------------------------------------------------------
// 共享 sandbox: install 一次, 所有测试共用 .claude/hooks/loop_engineering/
// ---------------------------------------------------------------------------

let SANDBOX = "";

beforeAll(() => {
  // 构建很快 (约几十 ms), 保证 cli/dist + adapter-cc/dist 都是最新产物
  execSync("npm run build", { cwd: REPO_ROOT, stdio: "pipe" });

  SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "loop-hook-e2e-"));
  execFileSync(process.execPath, [
    CLI_BUNDLE,
    "install",
    "--host",
    "cc",
    "--project-dir",
    SANDBOX,
  ], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });

  // 验证 install 真把 4 个 hook 落了 (与 install_e2e 重叠但本测试不假设它先跑)
  const hooksDir = path.join(SANDBOX, ".claude", "hooks", "loop_engineering");
  for (const n of ["probe_and_gate", "guard_paths", "post_task_collect", "guard_anchors"]) {
    const f = path.join(hooksDir, `${n}.mjs`);
    if (!fs.existsSync(f) || fs.statSync(f).size === 0) {
      throw new Error(`install 未正确落 hook: ${f}`);
    }
  }
});

afterAll(() => {
  if (SANDBOX) {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runs/ 隔离: 每个测试从空 runs/ 开始 (findActiveRun 不会串台)
// ---------------------------------------------------------------------------

beforeEach(() => {
  const runsDir = path.join(SANDBOX, "runs");
  fs.rmSync(runsDir, { recursive: true, force: true });
  fs.mkdirSync(runsDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// 夹具: 造 run-state.json + (可选) task-plan.yaml
// ---------------------------------------------------------------------------

interface RunStateOpts {
  phase?: string;
  active_tasks?: string[];
  trust_mode?: string;
  complexity?: string;
  human_pending?: string | null;
}

interface TaskFixture {
  id: string;
  allowed_write_paths?: string[];
  status?: string;
}

function makeRun(
  runId: string,
  state?: RunStateOpts,
  tasks?: TaskFixture[],
): string {
  const runDir = path.join(SANDBOX, "runs", runId);
  fs.mkdirSync(path.join(runDir, "planning"), { recursive: true });
  fs.mkdirSync(path.join(runDir, "tasks"), { recursive: true });

  const st: Record<string, unknown> = {
    run_id: runId,
    phase: state?.phase ?? "IMPLEMENTING",
    complexity: state?.complexity ?? "simple",
    trust_mode: state?.trust_mode ?? "collaborative",
    active_tasks: state?.active_tasks ?? [],
  };
  if (state?.human_pending !== undefined) {
    st.human_pending = state.human_pending;
  }
  fs.writeFileSync(
    path.join(runDir, "run-state.json"),
    JSON.stringify(st, null, 2),
    "utf-8",
  );

  if (tasks) {
    const plan = {
      schema: "loop-engineering.task-plan.v2",
      complexity: state?.complexity ?? "simple",
      tasks: tasks.map((t) => ({
        id: t.id,
        title: `task ${t.id}`,
        allowed_write_paths: t.allowed_write_paths ?? [],
        acceptance_refs: ["AC1"],
        status: t.status ?? "running",
      })),
    };
    fs.writeFileSync(
      path.join(runDir, "planning", "task-plan.yaml"),
      yaml.dump(plan),
      "utf-8",
    );
  }

  return runDir;
}

// ---------------------------------------------------------------------------
// 子进程 helper: spawn `node <hook>.mjs`, 喂 stdin, 收 stdout
// ---------------------------------------------------------------------------

interface HookResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * 调一个 hook .mjs, 模拟 CC 真实 stdin 协议。
 *
 * 用 `node` 而非 `process.execPath`: CC 在生产环境用 `node hook.mjs` 注册,
 * 本测试就是要复现生产路径 (bun 跑 hook 是开发态, 不是 publish 后的形态)。
 */
function runHook(
  name: string,
  payload: Record<string, unknown>,
): HookResult {
  const hookPath = path.join(
    SANDBOX,
    ".claude",
    "hooks",
    "loop_engineering",
    `${name}.mjs`,
  );
  const r = spawnSync("node", [hookPath], {
    input: JSON.stringify(payload),
    cwd: SANDBOX,
    encoding: "utf-8",
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

type Decision =
  | { kind: "allow" }
  | { kind: "block"; reason: string }
  | { kind: "defer"; context: Record<string, unknown> };

/** 把 CC stdout 解析为 Decision; 空串 / 非法 JSON 当 allow。 */
function parseDecision(stdout: string): Decision {
  const trimmed = stdout.trim();
  if (!trimmed) return { kind: "allow" };
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return { kind: "allow" };
  }
  if (obj.decision === "block") {
    return { kind: "block", reason: String(obj.reason ?? "") };
  }
  const addCtx = (obj.hookSpecificOutput as Record<string, unknown> | undefined)
    ?.additionalContext;
  if (typeof addCtx === "string") {
    try {
      return { kind: "defer", context: JSON.parse(addCtx) };
    } catch {
      return { kind: "defer", context: {} };
    }
  }
  return { kind: "allow" };
}

// ===========================================================================
// probe_and_gate (SessionStart)
// ===========================================================================

test("probe_and_gate: 无活跃 run → defer + capabilities 注入", () => {
  // runs/ 已被 beforeEach 清空, findActiveRun 返回 null
  const r = runHook("probe_and_gate", {
    hook_event_name: "SessionStart",
    cwd: SANDBOX,
  });
  expect(r.status).toBe(0);

  const d = parseDecision(r.stdout);
  expect(d.kind).toBe("defer");
  if (d.kind !== "defer") return;
  const caps = d.context.capabilities as Record<string, unknown> | undefined;
  expect(caps).toBeDefined();
  expect(typeof caps!.git_diff).toBe("boolean");
  // 环境事实: 测试机 git 可用 → true (Python 与 TS 等价锚点)
  expect(caps!.git_diff).toBe(true);
});

test("probe_and_gate: 活跃 run + unattended 无通道 → deny block + reason", () => {
  makeRun("20260628-001", {
    phase: "IMPLEMENTING",
    trust_mode: "unattended",
    active_tasks: ["T1"],
  });

  const r = runHook("probe_and_gate", {
    hook_event_name: "SessionStart",
    cwd: SANDBOX,
  });
  expect(r.status).toBe(0);

  const d = parseDecision(r.stdout);
  expect(d.kind).toBe("block");
  if (d.kind === "block") {
    expect(d.reason).toContain("unattended");
  }
});

// ===========================================================================
// guard_paths (PreToolUse Write)
// ===========================================================================

test("guard_paths: IMPLEMENTING + allowed=[src/**] + 写 src/a.ts → allow (空 stdout)", () => {
  makeRun(
    "20260628-002",
    { phase: "IMPLEMENTING", active_tasks: ["T1"] },
    [{ id: "T1", allowed_write_paths: ["src/**"] }],
  );

  const r = runHook("guard_paths", {
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: path.join(SANDBOX, "src", "a.ts") },
    cwd: SANDBOX,
  });
  expect(r.status).toBe(0);
  expect(parseDecision(r.stdout).kind).toBe("allow");
});

test("guard_paths: 写 .claude/settings.json → deny block (永远 deny 区)", () => {
  makeRun(
    "20260628-003",
    { phase: "IMPLEMENTING", active_tasks: ["T1"] },
    [{ id: "T1", allowed_write_paths: ["src/**"] }],
  );

  const r = runHook("guard_paths", {
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: path.join(SANDBOX, ".claude", "settings.json") },
    cwd: SANDBOX,
  });
  expect(r.status).toBe(0);
  expect(parseDecision(r.stdout).kind).toBe("block");
});

test("guard_paths: 写 docs/x.md (不在 allowed_write_paths) → deny block (OOB)", () => {
  makeRun(
    "20260628-004",
    { phase: "IMPLEMENTING", active_tasks: ["T1"] },
    [{ id: "T1", allowed_write_paths: ["src/**"] }],
  );

  const r = runHook("guard_paths", {
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: path.join(SANDBOX, "docs", "x.md") },
    cwd: SANDBOX,
  });
  expect(r.status).toBe(0);
  expect(parseDecision(r.stdout).kind).toBe("block");
});

// ===========================================================================
// guard_anchors (Stop)
// ===========================================================================

test("guard_anchors: phase=COMPLETE → allow", () => {
  makeRun("20260628-005", { phase: "COMPLETE", active_tasks: [] });

  const r = runHook("guard_anchors", {
    hook_event_name: "Stop",
    cwd: SANDBOX,
  });
  expect(r.status).toBe(0);
  expect(parseDecision(r.stdout).kind).toBe("allow");
});

test("guard_anchors: phase=ABORTED → allow", () => {
  makeRun("20260628-006", { phase: "ABORTED", active_tasks: [] });

  const r = runHook("guard_anchors", {
    hook_event_name: "Stop",
    cwd: SANDBOX,
  });
  expect(r.status).toBe(0);
  expect(parseDecision(r.stdout).kind).toBe("allow");
});

// ===========================================================================
// post_task_collect (PostToolUse Task)
// ===========================================================================

test("post_task_collect: 非 LE worker (general-purpose) → 静默放行 (不干扰宿主原生 Task)", () => {
  // runs/ 已被 beforeEach 清空; classifyWorker 对非 LE subagent_type 返回 null → passSilent
  const r = runHook("post_task_collect", {
    hook_event_name: "PostToolUse",
    tool_name: "Task",
    tool_input: { subagent_type: "general-purpose", prompt: "do something unrelated" },
    tool_response: { content: "done" },
    cwd: SANDBOX,
  });
  expect(r.status).toBe(0);
  expect(parseDecision(r.stdout).kind).toBe("allow");
});

test("post_task_collect: LE worker (implementation-worker) + 无活跃 run → deny block", () => {
  // runs/ 已清空; worker 交回但没 init run → §0.4 artifact-first 违反 → 拒绝
  const r = runHook("post_task_collect", {
    hook_event_name: "PostToolUse",
    tool_name: "Task",
    tool_input: { subagent_type: "implementation-worker", prompt: "..." },
    tool_response: { content: "done" },
    cwd: SANDBOX,
  });
  expect(r.status).toBe(0);
  const d = parseDecision(r.stdout);
  expect(d.kind).toBe("block");
  if (d.kind === "block") {
    // reason 提示主 agent 必须先 init_run_dir
    expect(d.reason).toMatch(/init|run 目录|活跃 run/);
  }
});
