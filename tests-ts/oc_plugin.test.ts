/**
 * OpenCode plugin binding 层单测 (P3 go/no-go 门禁的一部分)。
 *
 * 目的: 验证 OC plugin 入口 (packages/adapter-oc/src/plugin/index.ts) 正确把 OC plugin API 的
 * 事件翻译成 shared 的 HookInput, 并把 HookOutput 翻译成 OC 动作:
 *   - tool.execute.before(write/edit): deny → throw 拦截; allow → 不 throw; 内部错误 → 退化放行。
 *   - tool.execute.after(task): 有 run 时落 actual-writes.json。
 *   - event(session.idle): 非阻断, 不抛错 (劝告式)。
 *   - 非 write/edit/task 工具不受影响。
 *
 * 不重测 shared 的算法 (guard_paths / post_task_collect logic 已有专门等价测试);
 * 这里只测 binding 翻译是否正确。
 *
 * 隔离策略: 每个用例用独立 os.tmpdir() repoRoot + 独立 runs/, 通过 LOOP_RUNS_ROOT 定位
 * (guard_paths / post_task_collect 的 findActiveRun 都尊重 LOOP_RUNS_ROOT); directory=repoRoot。
 */

import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// 直接 import plugin 入口源码 (package main 指向 src/index.ts, 不 re-export plugin, 故用相对路径)。
import {
  LoopEngineeringPlugin,
} from "../packages/adapter-oc/src/plugin/index.js";
import type {
  OcClient,
  OcPluginHooks,
  OcToolAfterOutput,
  OcToolBeforeOutput,
  OcToolInputMeta,
} from "../packages/adapter-oc/src/plugin/runtime.js";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const _toClean: string[] = [];
const _envBackup = process.env.LOOP_RUNS_ROOT;

afterEach(() => {
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

function makeRepoRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-ocplugin-${label}-`));
  _toClean.push(root);
  return root;
}

/**
 * 建 runs/<runId>/ (含 planning/tasks/clarification/wrap-up 子目录),
 * 写 run-state.json + (可选) task-plan.yaml, 设 LOOP_RUNS_ROOT。返回 runDir。
 */
function makeRun(
  repoRoot: string,
  runId: string,
  state: Record<string, unknown>,
  planYaml?: string,
): string {
  const runsRoot = path.join(repoRoot, "runs");
  const runDir = path.join(runsRoot, runId);
  fs.mkdirSync(path.join(runDir, "planning"), { recursive: true });
  fs.mkdirSync(path.join(runDir, "tasks"), { recursive: true });
  fs.mkdirSync(path.join(runDir, "clarification"), { recursive: true });
  fs.mkdirSync(path.join(runDir, "wrap-up"), { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "run-state.json"),
    JSON.stringify(state),
    "utf-8",
  );
  if (planYaml !== undefined) {
    fs.writeFileSync(
      path.join(runDir, "planning", "task-plan.yaml"),
      planYaml,
      "utf-8",
    );
  }
  process.env.LOOP_RUNS_ROOT = runsRoot;
  return runDir;
}

/** 单 task t1 (status=running), allowed_write_paths=src/**。 */
const IMPL_PLAN =
  "schema: loop-engineering.task-plan.v2\n" +
  "complexity: simple\n" +
  "tasks:\n" +
  "  - id: t1\n" +
  "    title: impl task\n" +
  "    allowed_write_paths:\n" +
  "      - src/**\n" +
  "    acceptance_refs:\n" +
  "      - AC1\n" +
  "    status: running\n";

/** 收集 advise 告警的假 client (验证劝告式告警被触发)。 */
function makeFakeClient(): { client: OcClient; logs: string[] } {
  const logs: string[] = [];
  const client: OcClient = {
    app: {
      log: (entry) => {
        logs.push(String(entry.message ?? ""));
        return undefined;
      },
    },
  };
  return { client, logs };
}

/** 实例化 plugin, 返回 hooks 对象 (directory=repoRoot)。 */
async function makePlugin(
  repoRoot: string,
  client?: OcClient,
): Promise<OcPluginHooks> {
  return LoopEngineeringPlugin({ directory: repoRoot, client });
}

// ===========================================================================
// hook 1: tool.execute.before → guard_paths
// ===========================================================================

// 用例 1: 写受保护路径 (.claude/x) 在活跃 run + IMPLEMENTING → throw 拦截
test("before: IMPLEMENTING + 写 .claude/x → throw 拦截", async () => {
  const repoRoot = makeRepoRoot("before-deny");
  makeRun(
    repoRoot,
    "20260101-001",
    {
      run_id: "20260101-001",
      phase: "IMPLEMENTING",
      complexity: "simple",
      trust_mode: "collaborative",
      active_tasks: ["t1"],
    },
    IMPL_PLAN,
  );
  const hooks = await makePlugin(repoRoot);
  const meta: OcToolInputMeta = { tool: "write" };
  const output: OcToolBeforeOutput = {
    args: {
      filePath: path.join(repoRoot, ".claude", "x.txt"),
      content: "x",
    },
  };

  // deny → throw; 断言抛错且 message 含 .claude
  let threw = false;
  let msg = "";
  try {
    await hooks["tool.execute.before"]!(meta, output);
  } catch (e) {
    threw = true;
    msg = e instanceof Error ? e.message : String(e);
  }
  expect(threw).toBe(true);
  expect(msg).toContain(".claude");
});

// 用例 2: 合法路径 (src/foo.ts 在 active task allowed=src/**) → 不 throw
test("before: IMPLEMENTING + 写 src/foo.ts (合法) → 不 throw", async () => {
  const repoRoot = makeRepoRoot("before-allow");
  makeRun(
    repoRoot,
    "20260101-002",
    {
      run_id: "20260101-002",
      phase: "IMPLEMENTING",
      complexity: "simple",
      trust_mode: "collaborative",
      active_tasks: ["t1"],
    },
    IMPL_PLAN,
  );
  const hooks = await makePlugin(repoRoot);
  const meta: OcToolInputMeta = { tool: "edit" };
  const output: OcToolBeforeOutput = {
    args: {
      filePath: path.join(repoRoot, "src", "foo.ts"),
      content: "x",
    },
  };

  // allow → 不抛
  await hooks["tool.execute.before"]!(meta, output); // 不抛即通过
  expect(true).toBe(true);
});

// 用例 3: 越界源码 (docs/x.md 不在 allowed) → throw, message 含 allowed_write_paths
test("before: IMPLEMENTING + 写 docs/x.md (越界) → throw 含 allowed_write_paths", async () => {
  const repoRoot = makeRepoRoot("before-oob");
  makeRun(
    repoRoot,
    "20260101-003",
    {
      run_id: "20260101-003",
      phase: "IMPLEMENTING",
      complexity: "simple",
      trust_mode: "collaborative",
      active_tasks: ["t1"],
    },
    IMPL_PLAN,
  );
  const hooks = await makePlugin(repoRoot);
  const meta: OcToolInputMeta = { tool: "write" };
  const output: OcToolBeforeOutput = {
    args: {
      filePath: path.join(repoRoot, "docs", "x.md"),
      content: "x",
    },
  };

  let msg = "";
  try {
    await hooks["tool.execute.before"]!(meta, output);
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  expect(msg).toContain("allowed_write_paths");
});

// 用例 4: 非 write/edit 工具 (read) → 不受影响 (不 throw, 即便写受保护路径)
test("before: 非 write/edit 工具 (read) → 不受影响", async () => {
  const repoRoot = makeRepoRoot("before-readtool");
  makeRun(
    repoRoot,
    "20260101-004",
    {
      run_id: "20260101-004",
      phase: "IMPLEMENTING",
      complexity: "simple",
      trust_mode: "collaborative",
      active_tasks: ["t1"],
    },
    IMPL_PLAN,
  );
  const hooks = await makePlugin(repoRoot);
  const meta: OcToolInputMeta = { tool: "read" };
  const output: OcToolBeforeOutput = {
    args: { filePath: path.join(repoRoot, ".claude", "x.txt") },
  };
  // read 工具不触发 guard_paths → 不抛
  await hooks["tool.execute.before"]!(meta, output);
  expect(true).toBe(true);
});

// 用例 5: 无活跃 run + 写源码 → 不 throw (loop 之外不干扰)
test("before: 无活跃 run + 写源码 → 不 throw", async () => {
  const repoRoot = makeRepoRoot("before-norun");
  // 设 LOOP_RUNS_ROOT 指向空 runs (无 run) → findActiveRun=null → allow
  process.env.LOOP_RUNS_ROOT = path.join(repoRoot, "runs");
  fs.mkdirSync(path.join(repoRoot, "runs"), { recursive: true });
  const hooks = await makePlugin(repoRoot);
  const meta: OcToolInputMeta = { tool: "write" };
  const output: OcToolBeforeOutput = {
    args: { filePath: path.join(repoRoot, "src", "foo.ts"), content: "x" },
  };
  await hooks["tool.execute.before"]!(meta, output);
  expect(true).toBe(true);
});

// ===========================================================================
// hook 2: tool.execute.after → post_task_collect
// ===========================================================================

// 用例 6: task 工具 (implementation-worker) 在有 run + 三 artifact 齐全 → 落 actual-writes.json
test("after: task(implementation-worker) → 落 actual-writes.json", async () => {
  const repoRoot = makeRepoRoot("after-impl");
  const runDir = makeRun(
    repoRoot,
    "20260101-005",
    {
      run_id: "20260101-005",
      phase: "IMPLEMENTING",
      complexity: "simple",
      trust_mode: "collaborative",
      active_tasks: ["t1"],
    },
    IMPL_PLAN,
  );
  // 写 implementation-worker 三必需 artifact (tests_green=true)
  const taskDir = path.join(runDir, "tasks", "t1");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, "test-results.yaml"),
    "tests_green: true\n",
    "utf-8",
  );
  fs.writeFileSync(path.join(taskDir, "summary.md"), "# done\n", "utf-8");
  fs.writeFileSync(path.join(taskDir, "key-diffs.yaml"), "diffs: []\n", "utf-8");

  const hooks = await makePlugin(repoRoot);
  const meta: OcToolInputMeta = { tool: "task" };
  const output: OcToolAfterOutput = {
    title: "impl done",
    output: "完成 src/foo.ts",
    args: { subagent_type: "implementation-worker", prompt: "do task" },
  };

  await hooks["tool.execute.after"]!(meta, output);

  // 断言 actual-writes.json 落盘
  const awPath = path.join(taskDir, "actual-writes.json");
  expect(fs.existsSync(awPath)).toBe(true);
  const aw = JSON.parse(fs.readFileSync(awPath, "utf-8"));
  expect(aw).toHaveProperty("source");
  expect(aw).toHaveProperty("writes");
});

// 用例 7: task 工具缺 artifact → deny → 劝告式告警 (after 不抛, 仅记录)
test("after: task 缺 artifact → 劝告式告警, 不抛错", async () => {
  const repoRoot = makeRepoRoot("after-missing");
  makeRun(
    repoRoot,
    "20260101-006",
    {
      run_id: "20260101-006",
      phase: "IMPLEMENTING",
      complexity: "simple",
      trust_mode: "collaborative",
      active_tasks: ["t1"],
    },
    IMPL_PLAN,
  );
  // 不写任何 artifact → handlePostTaskCollect deny
  const { client, logs } = makeFakeClient();
  const hooks = await makePlugin(repoRoot, client);
  const meta: OcToolInputMeta = { tool: "task" };
  const output: OcToolAfterOutput = {
    args: { subagent_type: "implementation-worker", prompt: "do task" },
  };

  // after 不抛错 (劝告式)
  await hooks["tool.execute.after"]!(meta, output);
  // 应有 1 条劝告告警, 含 "post_task_collect"
  expect(logs.some((m) => m.includes("post_task_collect"))).toBe(true);
});

// 用例 8: 非 task 工具 (write) 走 after → 不落 actual-writes, 不告警
test("after: 非 task 工具 (write) → 不受影响", async () => {
  const repoRoot = makeRepoRoot("after-nontask");
  makeRun(repoRoot, "20260101-007", {
    run_id: "20260101-007",
    phase: "IMPLEMENTING",
    complexity: "simple",
    trust_mode: "collaborative",
    active_tasks: ["t1"],
  });
  const { client, logs } = makeFakeClient();
  const hooks = await makePlugin(repoRoot, client);
  const meta: OcToolInputMeta = { tool: "write" };
  const output: OcToolAfterOutput = { title: "wrote file" };
  await hooks["tool.execute.after"]!(meta, output);
  // 非 task 工具不触发 post_task_collect: 无 post_task_collect 相关告警
  // (plugin-init 的 probe_and_gate capabilities 告警不算; 故按 marker 过滤而非总数)。
  expect(logs.some((m) => m.includes("post_task_collect"))).toBe(false);
});

// ===========================================================================
// hook 3: event session.idle → guard_anchors
// ===========================================================================

// 用例 9: session.idle 在 IMPLEMENTING + 无 artifact (deny) → 不抛错 (劝告式)
test("event: session.idle (guard_anchors deny) → 不抛错, 劝告式告警", async () => {
  const repoRoot = makeRepoRoot("event-idle");
  makeRun(
    repoRoot,
    "20260101-008",
    {
      run_id: "20260101-008",
      phase: "IMPLEMENTING",
      complexity: "simple",
      trust_mode: "collaborative",
      active_tasks: ["t1"],
    },
    IMPL_PLAN,
  );
  // 无 test-results.yaml → guard_anchors deny (IMPLEMENTING task 未完成)
  const { client, logs } = makeFakeClient();
  const hooks = await makePlugin(repoRoot, client);

  // event 非阻断: 不抛错
  await hooks.event!({ event: { type: "session.idle" } });
  // 应有劝告告警 (含 guard_anchors)
  expect(logs.some((m) => m.includes("guard_anchors"))).toBe(true);
});

// 用例 10: session.idle 无活跃 run → allow → 不告警 不抛错
test("event: session.idle 无活跃 run → 静默 (不告警不抛错)", async () => {
  const repoRoot = makeRepoRoot("event-idle-norun");
  process.env.LOOP_RUNS_ROOT = path.join(repoRoot, "runs");
  fs.mkdirSync(path.join(repoRoot, "runs"), { recursive: true });
  const { client, logs } = makeFakeClient();
  const hooks = await makePlugin(repoRoot, client);
  await hooks.event!({ event: { type: "session.idle" } });
  // 无活跃 run → guard_anchors allow → 无 guard_anchors 告警
  // (plugin-init 的 probe_and_gate capabilities 告警不算)。
  expect(logs.some((m) => m.includes("guard_anchors"))).toBe(false);
});

// 用例 11: 未知 event 类型 → 忽略 (不抛错)
test("event: 未知事件类型 → 忽略不抛错", async () => {
  const repoRoot = makeRepoRoot("event-unknown");
  process.env.LOOP_RUNS_ROOT = path.join(repoRoot, "runs");
  fs.mkdirSync(path.join(repoRoot, "runs"), { recursive: true });
  const hooks = await makePlugin(repoRoot);
  await hooks.event!({ event: { type: "tool.execute.other" } });
  expect(true).toBe(true);
});

// ===========================================================================
// plugin-init / session.created → probe_and_gate
// ===========================================================================

// 用例 12: plugin 工厂实例化 (plugin-init 跑 probe_and_gate) 不抛错, 返回 hooks 对象
test("plugin-init: 实例化不抛错且返回 3 个 hook", async () => {
  const repoRoot = makeRepoRoot("init");
  process.env.LOOP_RUNS_ROOT = path.join(repoRoot, "runs");
  fs.mkdirSync(path.join(repoRoot, "runs"), { recursive: true });
  const hooks = await makePlugin(repoRoot);
  expect(typeof hooks["tool.execute.before"]).toBe("function");
  expect(typeof hooks["tool.execute.after"]).toBe("function");
  expect(typeof hooks.event).toBe("function");
});

// 用例 13: session.created → probe_and_gate (best-effort) 不抛错
test("event: session.created → probe_and_gate 不抛错", async () => {
  const repoRoot = makeRepoRoot("event-created");
  process.env.LOOP_RUNS_ROOT = path.join(repoRoot, "runs");
  fs.mkdirSync(path.join(repoRoot, "runs"), { recursive: true });
  const hooks = await makePlugin(repoRoot);
  await hooks.event!({ event: { type: "session.created" } });
  expect(true).toBe(true);
});
