/**
 * guard_paths hook (logic.ts) 行为等价测试。
 *
 * 目的: 验证 TS `handle(input)` 与 Python `hooks/loop_engineering/guard_paths.py`
 *       行为等价 (P1 go/no-go 门禁的一部分)。Python 为行为权威。
 *
 * 覆盖范围:
 *   - logic.ts 底部注释列出的 10 条用例 (1:1 对照)。
 *   - Python tests/test_hooks_smoke.py::TestGuardPaths 里有但 10 条没覆盖的补充用例。
 *
 * 夹具策略:
 *   - 每个用例在 os.tmpdir() 下造**独立**临时仓库根 (cwd), 内含 runs/<id>/。
 *     不同 runDir 避免 logic.ts 的 module-level task-plan 缓存 (mtime 失效) 串台。
 *   - run-state.json / task-plan.yaml 字段名严格照 run_state.ts (isRunState) /
 *     task_plan.ts (isTaskPlan) 的读取逻辑造; yaml 用 shared 已依赖的 js-yaml 序列化。
 *   - HookInput.cwd = 临时仓库根; findActiveRun(cwd) 扫 <cwd>/runs, 无需 LOOP_RUNS_ROOT。
 */
import { test, expect, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { handleGuardPaths } from "@e2e-loop/shared";
import type { HookInput } from "@e2e-loop/shared";

// ---------------------------------------------------------------------------
// 夹具工具
// ---------------------------------------------------------------------------

/** 收集创建的临时目录, 测试结束统一清理。 */
const tmpRoots: string[] = [];

/** run-state.json 可配置字段 (其余按 isRunState 必需项给默认)。 */
interface StateOverrides {
  phase?: string;
  active_tasks?: string[];
  trust_mode?: string;
  complexity?: string;
  human_pending?: string | null;
}

/** task-plan.yaml 里的最简 task (照 isTaskPlan 必需字段)。 */
interface TaskFixture {
  id: string;
  title?: string;
  allowed_write_paths?: string[];
  acceptance_refs?: string[];
  status?: string;
}

/**
 * 在 tmpdir 下造一个独立临时仓库根, 写入 runs/<runId>/run-state.json
 * (+ 可选 task-plan.yaml), 返回 { repoRoot, runDir, runId }。
 *
 * @param opts.runId       run 目录名 (默认每个夹具唯一, 形如 20260101-001)
 * @param opts.state       run-state 覆盖字段 (phase / active_tasks 等)
 * @param opts.tasks       task-plan.yaml 的 tasks; 传 undefined 则不写 task-plan
 * @param opts.writeState  是否写 run-state.json (默认 true; false 用于"无 run-state"场景)
 */
function makeRepo(opts: {
  runId?: string;
  state?: StateOverrides;
  tasks?: TaskFixture[];
  writeState?: boolean;
}): { repoRoot: string; runDir: string; runId: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gp-test-"));
  tmpRoots.push(repoRoot);

  const runId = opts.runId ?? "20260101-001";
  const runDir = path.join(repoRoot, "runs", runId);
  fs.mkdirSync(path.join(runDir, "planning"), { recursive: true });

  const writeState = opts.writeState ?? true;
  if (writeState) {
    // 字段名 1:1 照 run_state.ts isRunState: run_id/phase/complexity/trust_mode 必需
    const state: Record<string, unknown> = {
      run_id: runId,
      phase: opts.state?.phase ?? "IMPLEMENTING",
      complexity: opts.state?.complexity ?? "simple",
      trust_mode: opts.state?.trust_mode ?? "collaborative",
      active_tasks: opts.state?.active_tasks ?? [],
    };
    if (opts.state?.human_pending !== undefined) {
      state.human_pending = opts.state.human_pending;
    }
    fs.writeFileSync(
      path.join(runDir, "run-state.json"),
      JSON.stringify(state, null, 2),
      "utf-8",
    );
  }

  if (opts.tasks !== undefined) {
    // 字段名 1:1 照 task_plan.ts isTaskPlan: id/title/allowed_write_paths/acceptance_refs
    const plan = {
      schema: "loop-engineering.task-plan.v2",
      complexity: opts.state?.complexity ?? "simple",
      tasks: opts.tasks.map((t) => ({
        id: t.id,
        title: t.title ?? `task ${t.id}`,
        allowed_write_paths: t.allowed_write_paths ?? [],
        acceptance_refs: t.acceptance_refs ?? ["AC1"],
        status: t.status ?? "running",
      })),
    };
    fs.writeFileSync(
      path.join(runDir, "planning", "task-plan.yaml"),
      yaml.dump(plan),
      "utf-8",
    );
  }

  return { repoRoot, runDir, runId };
}

/** 构造 Write 类 HookInput (照 normalizeToolFilePath 期望的 toolInput 形状)。 */
function writeInput(cwd: string, absFilePath: string): HookInput {
  return {
    event: "PreToolUse",
    toolName: "Write",
    toolInput: { file_path: absFilePath, content: "x" },
    cwd,
  };
}

afterAll(() => {
  for (const root of tmpRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // 清理失败 (Windows 文件锁等) 不影响测试结论, 忽略
    }
  }
});

// ===========================================================================
// logic.ts 底部注释的 10 条用例 (1:1 对照)
// ===========================================================================

// 用例 1: 无活跃 run + 写任意路径 → allow (loop 之外不干扰)
test("用例1: 无活跃 run + 写源码 → allow", async () => {
  // repoRoot 下无 runs/ (makeRepo 一定建 runs/<id>, 故单独造一个空 repo)
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gp-test-"));
  tmpRoots.push(repoRoot);
  // 不建任何 run → findActiveRun 返回 null
  const out = await handleGuardPaths(
    writeInput(repoRoot, path.join(repoRoot, "src", "foo.ts")),
  );
  expect(out.decision).toBe("allow");
});

// 用例 2: IMPLEMENTING + 写 .claude/x → deny; reason 含 ".claude"
test("用例2: 写 .claude/ → deny 含 '.claude'", async () => {
  const { repoRoot } = makeRepo({ state: { phase: "IMPLEMENTING" } });
  const out = await handleGuardPaths(
    writeInput(repoRoot, path.join(repoRoot, ".claude", "anything.txt")),
  );
  expect(out.decision).toBe("deny");
  expect(out.reason ?? "").toContain(".claude");
});

// 用例 3: IMPLEMENTING + 写 loop_engineering/x → deny; reason 含 "loop_engineering"
test("用例3: 写 loop_engineering/ → deny 含 'loop_engineering'", async () => {
  const { repoRoot } = makeRepo({ state: { phase: "IMPLEMENTING" } });
  const out = await handleGuardPaths(
    writeInput(repoRoot, path.join(repoRoot, "loop_engineering", "x.py")),
  );
  expect(out.decision).toBe("deny");
  expect(out.reason ?? "").toContain("loop_engineering");
});

// 用例 4: IMPLEMENTING + active task allowed=["src/**"] + 写 src/foo.ts → allow
test("用例4: IMPLEMENTING + allowed=['src/**'] 写 src/foo.ts → allow", async () => {
  const { repoRoot } = makeRepo({
    state: { phase: "IMPLEMENTING", active_tasks: ["t1"] },
    tasks: [{ id: "t1", allowed_write_paths: ["src/**"], status: "running" }],
  });
  const out = await handleGuardPaths(
    writeInput(repoRoot, path.join(repoRoot, "src", "foo.ts")),
  );
  expect(out.decision).toBe("allow");
});

// 用例 5: IMPLEMENTING + active task allowed=["src/**"] + 写 docs/x.md → deny; reason 含 "allowed_write_paths"
test("用例5: IMPLEMENTING + 写 docs/x.md (越界) → deny 含 'allowed_write_paths'", async () => {
  const { repoRoot } = makeRepo({
    state: { phase: "IMPLEMENTING", active_tasks: ["t1"] },
    tasks: [{ id: "t1", allowed_write_paths: ["src/**"], status: "running" }],
  });
  const out = await handleGuardPaths(
    writeInput(repoRoot, path.join(repoRoot, "docs", "x.md")),
  );
  expect(out.decision).toBe("deny");
  expect(out.reason ?? "").toContain("allowed_write_paths");
});

// 用例 6: PLANNING + 写 planning/design.md → allow
test("用例6: PLANNING + 写 planning/design.md → allow", async () => {
  const { repoRoot, runId } = makeRepo({ state: { phase: "PLANNING" } });
  const out = await handleGuardPaths(
    writeInput(
      repoRoot,
      path.join(repoRoot, "runs", runId, "planning", "design.md"),
    ),
  );
  expect(out.decision).toBe("allow");
});

// 用例 7: IMPLEMENTING + 写 planning/design.md → deny; reason 含 "CREATED/CLARIFYING/PLANNING"
test("用例7: IMPLEMENTING + 写 planning/ → deny 含 phase 限制说明", async () => {
  const { repoRoot, runId } = makeRepo({ state: { phase: "IMPLEMENTING" } });
  const out = await handleGuardPaths(
    writeInput(
      repoRoot,
      path.join(repoRoot, "runs", runId, "planning", "design.md"),
    ),
  );
  expect(out.decision).toBe("deny");
  expect(out.reason ?? "").toContain("CREATED/CLARIFYING/PLANNING");
});

// 用例 8: 写 runs/<id>/run-state.json → allow (协调者写状态)
test("用例8: 写 runs/<id>/run-state.json → allow", async () => {
  const { repoRoot, runId } = makeRepo({ state: { phase: "IMPLEMENTING" } });
  const out = await handleGuardPaths(
    writeInput(repoRoot, path.join(repoRoot, "runs", runId, "run-state.json")),
  );
  expect(out.decision).toBe("allow");
});

// 用例 9: IMPLEMENTING + 写活跃 task 的 tasks/<tid>/summary.md (tid=active) → allow
test("用例9: IMPLEMENTING + 写活跃 task 的 tasks/<tid>/ → allow", async () => {
  const { repoRoot, runId } = makeRepo({
    state: { phase: "IMPLEMENTING", active_tasks: ["t1"] },
    tasks: [{ id: "t1", allowed_write_paths: ["src/**"], status: "running" }],
  });
  const out = await handleGuardPaths(
    writeInput(
      repoRoot,
      path.join(repoRoot, "runs", runId, "tasks", "t1", "summary.md"),
    ),
  );
  expect(out.decision).toBe("allow");
});

// 用例 10: 内部异常 → deny (不静默放过)
test("用例10: 内部异常 → deny", async () => {
  // 制造 normalizeToolFilePath 之后、catch 之前的异常:
  // findActiveRun 用 input.cwd, 给一个 toolInput.file_path 在 cwd 内 (过 relToRepo),
  // 但把 cwd 指向一个存在的 run, 然后让 task-plan.yaml 是非法 YAML? —— 那会被 safeReadTaskPlan 吞掉返回 null。
  // 更直接: 让 input 本身触发异常。normalizeToolFilePath 对 cwd 非字符串会抛 (path.resolve)。
  // 给 cwd 传一个非字符串 (绕过类型) 触发 path API 抛错, 命中 catch → deny。
  const badInput = {
    event: "PreToolUse",
    toolName: "Write",
    toolInput: { file_path: "src/foo.ts", content: "x" },
    // @ts-expect-error 故意传非法 cwd 触发 path.resolve 抛错, 验证 catch → deny
    cwd: 12345,
  } as unknown as HookInput;
  const out = await handleGuardPaths(badInput);
  expect(out.decision).toBe("deny");
  expect(out.reason ?? "").toContain("内部错误");
});

// ===========================================================================
// 补充: test_hooks_smoke.py 里有、上面 10 条未直接覆盖的
// ===========================================================================

// 补1 (smoke: test_source_write_outside_allowed_paths_denied 已被用例5 覆盖, 此处补
//       "无 active task" 的源码写入分支): IMPLEMENTING 但找不到 running task → deny
test("补1: IMPLEMENTING + 无 running task + 写源码 → deny", async () => {
  const { repoRoot } = makeRepo({
    state: { phase: "IMPLEMENTING", active_tasks: [] },
    tasks: [{ id: "t1", allowed_write_paths: ["src/**"], status: "pending" }],
  });
  const out = await handleGuardPaths(
    writeInput(repoRoot, path.join(repoRoot, "src", "foo.ts")),
  );
  expect(out.decision).toBe("deny");
  expect(out.reason ?? "").toContain("找不到 status=running 的 task");
});

// 补2: 写非活跃 task 的 tasks/<other>/ → deny (规则 5 的拒绝分支)
test("补2: 写非活跃 task 的 tasks/<other>/ → deny", async () => {
  const { repoRoot, runId } = makeRepo({
    state: { phase: "IMPLEMENTING", active_tasks: ["t1"] },
    tasks: [{ id: "t1", allowed_write_paths: ["src/**"], status: "running" }],
  });
  const out = await handleGuardPaths(
    writeInput(
      repoRoot,
      path.join(repoRoot, "runs", runId, "tasks", "t2", "summary.md"),
    ),
  );
  expect(out.decision).toBe("deny");
  expect(out.reason ?? "").toContain("不是当前活跃");
});

// 补3: run 处于终态 (COMPLETE, 非治理 phase) → 即便写 .claude/ 也静默放行
//      (findActiveRun 跳过终态 run, 故等价于"无活跃 run")
test("补3: 终态 run (COMPLETE) → 写 .claude/ 仍 allow (非治理)", async () => {
  const { repoRoot } = makeRepo({ state: { phase: "COMPLETE" } });
  const out = await handleGuardPaths(
    writeInput(repoRoot, path.join(repoRoot, ".claude", "x.txt")),
  );
  expect(out.decision).toBe("allow");
});

// 补4: run 目录存在但 run-state.json 缺失 → 退化放行 (state===null 分支)
//      注意 findActiveRun 也会因读不到 state 而跳过, 故等价于无活跃 run → allow
test("补4: run-state.json 缺失 → 写源码仍 allow (退化放行)", async () => {
  const { repoRoot } = makeRepo({ writeState: false });
  const out = await handleGuardPaths(
    writeInput(repoRoot, path.join(repoRoot, "src", "foo.ts")),
  );
  expect(out.decision).toBe("allow");
});

// 补5: 仓库外写入 (file_path 不在 cwd 内) → 静默放行 (relToRepo===null 分支)
test("补5: 仓库外写入 → allow (不归本 hook 管)", async () => {
  const { repoRoot } = makeRepo({ state: { phase: "IMPLEMENTING" } });
  // 另造一个独立 tmp 目录作为"仓库外"目标
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gp-outside-"));
  tmpRoots.push(outsideRoot);
  const out = await handleGuardPaths(
    writeInput(repoRoot, path.join(outsideRoot, "external.txt")),
  );
  expect(out.decision).toBe("allow");
});

// 补6: clarification/ 在 CLARIFYING phase → allow (规则 7 放行分支, 10 条未覆盖)
test("补6: CLARIFYING + 写 clarification/questions.json → allow", async () => {
  const { repoRoot, runId } = makeRepo({ state: { phase: "CLARIFYING" } });
  const out = await handleGuardPaths(
    writeInput(
      repoRoot,
      path.join(repoRoot, "runs", runId, "clarification", "questions.json"),
    ),
  );
  expect(out.decision).toBe("allow");
});

// 补7: wrap-up/ 在 WRAPPING_UP phase → allow (规则 8 放行分支, 10 条未覆盖)
test("补7: WRAPPING_UP + 写 wrap-up/check-result.json → allow", async () => {
  const { repoRoot, runId } = makeRepo({ state: { phase: "WRAPPING_UP" } });
  const out = await handleGuardPaths(
    writeInput(
      repoRoot,
      path.join(repoRoot, "runs", runId, "wrap-up", "check-result.json"),
    ),
  );
  expect(out.decision).toBe("allow");
});

// 补8: 非 IMPLEMENTING (PLANNING) + 写源码 → deny (规则 9 的 phase 拒绝分支)
test("补8: PLANNING + 写源码 src/foo.ts → deny (仅 IMPLEMENTING 可写源码)", async () => {
  const { repoRoot } = makeRepo({ state: { phase: "PLANNING" } });
  const out = await handleGuardPaths(
    writeInput(repoRoot, path.join(repoRoot, "src", "foo.ts")),
  );
  expect(out.decision).toBe("deny");
  expect(out.reason ?? "").toContain("仅 IMPLEMENTING 可写源码");
});
