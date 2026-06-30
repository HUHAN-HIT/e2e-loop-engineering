/**
 * guard_paths hook 写者身份治理 (B 案) 测试.
 *
 * 目的: 验证 caller="main" 时, 主 agent 写 worker 红线路径被拒;
 *       caller={ agent_id, agent_type } (子 agent) 或 caller=undefined (OC 退化) 时
 *       不触发身份治理, 退化到原 phase+task 治理.
 *
 * 不重复 guard_paths.test.ts 已覆盖的路径白名单规则 1-10, 仅验证 B 案新增维度:
 *   W1-W7: 主 agent 写 worker 红线路径 → deny (含可执行指引 reason)
 *   W8:   主 agent 写源码 (IMPLEMENTING) → deny
 *   W9:   主 agent 写状态文件 → allow (Coordinator 合法写者)
 *   W10:  caller=undefined (OC 模拟) + 写 worker 红线路径 → allow (退化, 不做身份治理)
 *
 * 夹具策略与 guard_paths.test.ts 一致: os.tmpdir() 下造独立临时仓库根.
 */
import { test, expect, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { handleGuardPaths } from "@e2e-loop/shared";
import type { HookInput } from "@e2e-loop/shared";

const tmpRoots: string[] = [];

interface StateOverrides {
  phase?: string;
  active_tasks?: string[];
  complexity?: string;
}

interface TaskFixture {
  id: string;
  allowed_write_paths?: string[];
  status?: string;
}

function makeRepo(opts: {
  runId?: string;
  state?: StateOverrides;
  tasks?: TaskFixture[];
}): { repoRoot: string; runDir: string; runId: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gp-wi-"));
  tmpRoots.push(repoRoot);

  const runId = opts.runId ?? "20260101-001";
  const runDir = path.join(repoRoot, "runs", runId);
  fs.mkdirSync(path.join(runDir, "planning"), { recursive: true });

  const state: Record<string, unknown> = {
    run_id: runId,
    phase: opts.state?.phase ?? "IMPLEMENTING",
    complexity: opts.state?.complexity ?? "simple",
    trust_mode: "collaborative",
    active_tasks: opts.state?.active_tasks ?? [],
  };
  fs.writeFileSync(
    path.join(runDir, "run-state.json"),
    JSON.stringify(state, null, 2),
    "utf-8",
  );

  if (opts.tasks !== undefined) {
    const plan = {
      schema: "loop-engineering.task-plan.v2",
      complexity: opts.state?.complexity ?? "simple",
      tasks: opts.tasks.map((t) => ({
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

  return { repoRoot, runDir, runId };
}

/** 主 agent (caller="main") 写文件的 HookInput. */
function mainAgentWrite(cwd: string, absFilePath: string): HookInput {
  return {
    event: "PreToolUse",
    toolName: "Write",
    toolInput: { file_path: absFilePath, content: "x" },
    cwd,
    caller: "main",
  };
}

/** 子 agent (implementation-worker) 写文件的 HookInput. */
function subagentWrite(
  cwd: string,
  absFilePath: string,
  agent_type = "implementation-worker",
): HookInput {
  return {
    event: "PreToolUse",
    toolName: "Write",
    toolInput: { file_path: absFilePath, content: "x" },
    cwd,
    caller: { agent_id: "test-subagent-id", agent_type },
  };
}

/** OC 模拟 (caller=undefined, 宿主未提供身份信息). */
function ocStyleWrite(cwd: string, absFilePath: string): HookInput {
  return {
    event: "PreToolUse",
    toolName: "Write",
    toolInput: { file_path: absFilePath, content: "x" },
    cwd,
    // caller 字段缺, 模拟 OC plugin runtime 不传身份信息
  };
}

afterAll(() => {
  for (const root of tmpRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
});

// ===========================================================================
// W1-W7: 主 agent (caller="main") 写 worker 红线路径 → deny
// ===========================================================================

test("W1: 主 agent 写 planning/design.md → deny 含 'plan-agent'", async () => {
  const { repoRoot, runId } = makeRepo({ state: { phase: "PLANNING" } });
  const out = await handleGuardPaths(
    mainAgentWrite(
      repoRoot,
      path.join(repoRoot, "runs", runId, "planning", "design.md"),
    ),
  );
  expect(out.decision).toBe("deny");
  expect(out.reason ?? "").toContain("写者身份");
  expect(out.reason ?? "").toContain("plan-agent");
});

test("W2: 主 agent 写 planning/plan-check-failures.json → allow (Coordinator 跑 plan_check 产物)", async () => {
  const { repoRoot, runId } = makeRepo({ state: { phase: "PLANNING" } });
  const out = await handleGuardPaths(
    mainAgentWrite(
      repoRoot,
      path.join(repoRoot, "runs", runId, "planning", "plan-check-failures.json"),
    ),
  );
  expect(out.decision).toBe("allow");
});

test("W3: 子 agent (plan-agent) 写 planning/design.md (PLANNING) → allow", async () => {
  const { repoRoot, runId } = makeRepo({ state: { phase: "PLANNING" } });
  const out = await handleGuardPaths(
    subagentWrite(
      repoRoot,
      path.join(repoRoot, "runs", runId, "planning", "design.md"),
      "plan-agent",
    ),
  );
  expect(out.decision).toBe("allow");
});

test("W4: 主 agent 写 tasks/<tid>/summary.md (IMPLEMENTING, tid=active) → deny 含 'implementation-worker'", async () => {
  const { repoRoot, runId } = makeRepo({
    state: { phase: "IMPLEMENTING", active_tasks: ["t1"] },
    tasks: [{ id: "t1", allowed_write_paths: ["src/**"], status: "running" }],
  });
  const out = await handleGuardPaths(
    mainAgentWrite(
      repoRoot,
      path.join(repoRoot, "runs", runId, "tasks", "t1", "summary.md"),
    ),
  );
  expect(out.decision).toBe("deny");
  expect(out.reason ?? "").toContain("写者身份");
  expect(out.reason ?? "").toContain("implementation-worker");
});

test("W4b: 主 agent 写 tasks/<tid>/test-results.yaml → deny 含 'implementation-worker'", async () => {
  const { repoRoot, runId } = makeRepo({
    state: { phase: "IMPLEMENTING", active_tasks: ["t1"] },
    tasks: [{ id: "t1", allowed_write_paths: ["src/**"], status: "running" }],
  });
  const out = await handleGuardPaths(
    mainAgentWrite(
      repoRoot,
      path.join(repoRoot, "runs", runId, "tasks", "t1", "test-results.yaml"),
    ),
  );
  expect(out.decision).toBe("deny");
  expect(out.reason ?? "").toContain("implementation-worker");
});

test("W4c: 主 agent 写 tasks/<tid>/dispatch.json → allow (Coordinator 单写者)", async () => {
  const { repoRoot, runId } = makeRepo({
    state: { phase: "IMPLEMENTING", active_tasks: ["t1"] },
    tasks: [{ id: "t1", allowed_write_paths: ["src/**"], status: "running" }],
  });
  const out = await handleGuardPaths(
    mainAgentWrite(
      repoRoot,
      path.join(repoRoot, "runs", runId, "tasks", "t1", "dispatch.json"),
    ),
  );
  expect(out.decision).toBe("allow");
});

test("W4d: 子 agent (implementation-worker) 写 tasks/<tid>/summary.md (tid=active) → allow", async () => {
  const { repoRoot, runId } = makeRepo({
    state: { phase: "IMPLEMENTING", active_tasks: ["t1"] },
    tasks: [{ id: "t1", allowed_write_paths: ["src/**"], status: "running" }],
  });
  const out = await handleGuardPaths(
    subagentWrite(
      repoRoot,
      path.join(repoRoot, "runs", runId, "tasks", "t1", "summary.md"),
    ),
  );
  expect(out.decision).toBe("allow");
});

test("W5: 主 agent 写 clarification/questions.json (CLARIFYING) → deny 含 'clarification-finder'", async () => {
  const { repoRoot, runId } = makeRepo({ state: { phase: "CLARIFYING" } });
  const out = await handleGuardPaths(
    mainAgentWrite(
      repoRoot,
      path.join(repoRoot, "runs", runId, "clarification", "questions.json"),
    ),
  );
  expect(out.decision).toBe("deny");
  expect(out.reason ?? "").toContain("clarification-finder");
});

test("W6: 主 agent 写 wrap-up/red-team-review.md (WRAPPING_UP) → deny 含 'red-team-reviewer'", async () => {
  const { repoRoot, runId } = makeRepo({ state: { phase: "WRAPPING_UP" } });
  const out = await handleGuardPaths(
    mainAgentWrite(
      repoRoot,
      path.join(repoRoot, "runs", runId, "wrap-up", "red-team-review.md"),
    ),
  );
  expect(out.decision).toBe("deny");
  expect(out.reason ?? "").toContain("red-team-reviewer");
});

test("W7: 主 agent 写 wrap-up/key-diffs.md (WRAPPING_UP) → allow (Coordinator 汇总)", async () => {
  const { repoRoot, runId } = makeRepo({ state: { phase: "WRAPPING_UP" } });
  const out = await handleGuardPaths(
    mainAgentWrite(
      repoRoot,
      path.join(repoRoot, "runs", runId, "wrap-up", "key-diffs.md"),
    ),
  );
  expect(out.decision).toBe("allow");
});

test("W7b: 主 agent 写 wrap-up/check-result.json (WRAPPING_UP) → allow (Coordinator 跑 wrap_up_check 产物)", async () => {
  const { repoRoot, runId } = makeRepo({ state: { phase: "WRAPPING_UP" } });
  const out = await handleGuardPaths(
    mainAgentWrite(
      repoRoot,
      path.join(repoRoot, "runs", runId, "wrap-up", "check-result.json"),
    ),
  );
  expect(out.decision).toBe("allow");
});

// ===========================================================================
// W8: 主 agent 在 IMPLEMENTING 写源码 → deny (规则 9 改造)
// ===========================================================================

test("W8: 主 agent + IMPLEMENTING + active task allowed=['src/**'] + 写 src/foo.ts → deny 含 'implementation-worker'", async () => {
  const { repoRoot } = makeRepo({
    state: { phase: "IMPLEMENTING", active_tasks: ["t1"] },
    tasks: [{ id: "t1", allowed_write_paths: ["src/**"], status: "running" }],
  });
  const out = await handleGuardPaths(
    mainAgentWrite(repoRoot, path.join(repoRoot, "src", "foo.ts")),
  );
  expect(out.decision).toBe("deny");
  expect(out.reason ?? "").toContain("implementation-worker");
});

test("W8b: 子 agent + IMPLEMENTING + active task allowed=['src/**'] + 写 src/foo.ts → allow (worker 正常写)", async () => {
  const { repoRoot } = makeRepo({
    state: { phase: "IMPLEMENTING", active_tasks: ["t1"] },
    tasks: [{ id: "t1", allowed_write_paths: ["src/**"], status: "running" }],
  });
  const out = await handleGuardPaths(
    subagentWrite(repoRoot, path.join(repoRoot, "src", "foo.ts")),
  );
  expect(out.decision).toBe("allow");
});

// ===========================================================================
// W9: 主 agent 写状态文件 → allow (Coordinator 合法写者)
// ===========================================================================

test("W9: 主 agent 写 runs/<id>/run-state.json → allow", async () => {
  const { repoRoot, runId } = makeRepo({ state: { phase: "IMPLEMENTING" } });
  const out = await handleGuardPaths(
    mainAgentWrite(repoRoot, path.join(repoRoot, "runs", runId, "run-state.json")),
  );
  expect(out.decision).toBe("allow");
});

// ===========================================================================
// W10: caller=undefined (OC 模拟) + 写 worker 红线路径 → 退化放行
//      (OC 无子 agent 概念, 不做身份治理, 退化到原 phase+task 治理)
// ===========================================================================

test("W10a: caller=undefined + PLANNING + 写 planning/design.md → allow (OC 退化)", async () => {
  const { repoRoot, runId } = makeRepo({ state: { phase: "PLANNING" } });
  const out = await handleGuardPaths(
    ocStyleWrite(
      repoRoot,
      path.join(repoRoot, "runs", runId, "planning", "design.md"),
    ),
  );
  expect(out.decision).toBe("allow");
});

test("W10b: caller=undefined + IMPLEMENTING + active task + 写 src/foo.ts → allow (OC 退化, 走原 allowed_write_paths 检查)", async () => {
  const { repoRoot } = makeRepo({
    state: { phase: "IMPLEMENTING", active_tasks: ["t1"] },
    tasks: [{ id: "t1", allowed_write_paths: ["src/**"], status: "running" }],
  });
  const out = await handleGuardPaths(
    ocStyleWrite(repoRoot, path.join(repoRoot, "src", "foo.ts")),
  );
  expect(out.decision).toBe("allow");
});

test("W10c: caller=undefined + CLARIFYING + 写 clarification/questions.json → allow (OC 退化)", async () => {
  const { repoRoot, runId } = makeRepo({ state: { phase: "CLARIFYING" } });
  const out = await handleGuardPaths(
    ocStyleWrite(
      repoRoot,
      path.join(repoRoot, "runs", runId, "clarification", "questions.json"),
    ),
  );
  expect(out.decision).toBe("allow");
});
