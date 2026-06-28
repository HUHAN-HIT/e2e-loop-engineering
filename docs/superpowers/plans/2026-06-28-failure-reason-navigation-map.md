# 失败原因与导航图实现计划

> **致 agentic worker：** 必备子技能：用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现本计划。各步骤用复选框（`- [ ]`）语法跟踪进度。

**目标：** 保持 workspace 各 manifest 合法（当前构建已绿），防止损坏的 package manifest 流入集成测试，并给 `e2e-loop status` 加一个只读导航图。

**架构：** 维持 `run-state.json` 与 `task-plan.yaml` 作为唯一状态源。新增一个纯 runtime 投影模块，读取既有状态与证据文件；再由 CLI 渲染该投影，**不改动**调度、门禁或 task 状态。

**技术栈：** TypeScript、Bun test、Node.js `fs/path`、既有 `@e2e-loop/ssot` runtime 导出、既有 `e2e-loop` CLI。

---

## 范围与优先级

本计划有意把"眼前的故障"与"操作者 UX"分开：

- P0：确认 `packages/ssot-ts/package.json` 是合法 JSON（仅在损坏时才修复），并保留 `./worktree` 子路径导出。截至 2026-06-28，该 manifest 已合法且 `npm run build` 退出码为 0，故这是一个"校验并加固"步骤，而非修复。
- P0.5：加一个 manifest guard，让非法的 workspace package JSON 在测试套件早期就失败。
- P1：给 `status` 加一个只读导航图投影。

导航图**绝不能**引入第二个状态源。它只是覆盖在既有文件之上的展示/投影层。

## 文件结构

- 修改：`packages/ssot-ts/package.json`
  - 职责：合法的 workspace package 元数据。
- 修改：`tests-ts/publish_contract.test.ts`
  - 职责：publish / package manifest 契约校验。
- 新建：`packages/ssot-ts/src/runtime/navigation_map.ts`
  - 职责：从 `RunState`、可选 `TaskPlan` 与证据文件，纯投影出一份紧凑的操作者导航图。
- 修改：`packages/ssot-ts/src/runtime/index.ts`
  - 职责：导出新的 runtime 投影 API。
- 修改：`packages/cli/src/commands/dryrun.ts`
  - 职责：在 `status` 中渲染导航图。
- 新建：`tests-ts/ssot/navigation_map.test.ts`
  - 职责：投影模块的聚焦单测。
- 修改：`tests-ts/integration_dry_run.test.ts`
  - 职责：CLI 层断言 `status` 暴露出导航图。

---

### 任务 1：修复非法的 workspace manifest

**文件：**
- 修改：`packages/ssot-ts/package.json`

- [ ] **步骤 1：检查 manifest**

运行：

```powershell
Get-Content packages\ssot-ts\package.json
```

预期（当前工作树）：文件已是合法 JSON，且包含 `"./worktree": "./src/worktree/index.ts"` 导出。**仅当** `description` 字段出现乱码/控制字符损坏、或 JSON 未闭合时，才进入步骤 2 修复。否则把步骤 2-4 当作"空操作确认"，直接进入任务 2。

- [ ] **步骤 2：（仅当步骤 1 发现损坏时）恢复为合法 JSON**

关键：务必保留 `"./worktree": "./src/worktree/index.ts"` 导出——删掉它会打断每一个 `@e2e-loop/ssot/worktree` 消费方（例如 `packages/cli/src/commands/dryrun.ts`）以及 worktree 测试。若必须重写整文件，应与当前合法工作树完全一致：

```json
{
  "name": "@e2e-loop/ssot",
  "version": "1.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./schema": "./src/schema/index.ts",
    "./state_machine": "./src/state_machine/index.ts",
    "./scheduling": "./src/scheduling/index.ts",
    "./checklists": "./src/checklists/index.ts",
    "./amendment": "./src/amendment/index.ts",
    "./multi_service": "./src/multi_service/index.ts",
    "./trust_mode": "./src/trust_mode/index.ts",
    "./worktree": "./src/worktree/index.ts",
    "./runtime": "./src/runtime/index.ts",
    "./dispatch": "./src/dispatch/index.ts",
    "./package.json": "./package.json"
  },
  "description": "TypeScript algorithm SSOT for Loop Engineering.",
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^3.23.0",
    "@e2e-loop/shared": "*",
    "js-yaml": "^4.1.0"
  }
}
```

- [ ] **步骤 3：验证 npm 能解析 workspace**

运行：

```powershell
npm run build
```

预期：`npm run build` 退出码为 0（manifest 可解析；当前工作树已满足）。之后若出现 TypeScript/构建错误，那是另一个独立问题，应按其自身报错信息单独评估。

- [ ] **步骤 4：单独提交本次修复（若步骤 1 未发现损坏则跳过）**

若步骤 2 改动了文件，运行：

```powershell
git add packages\ssot-ts\package.json
git commit -m "fix: repair ssot package manifest"
```

预期：提交成功，且仅暂存了 `packages/ssot-ts/package.json`。若 manifest 本就合法，则无可暂存内容——跳过本次提交。

---

### 任务 2：加一个 workspace manifest guard

**文件：**
- 修改：`tests-ts/publish_contract.test.ts`

- [ ] **步骤 1：写一个会失败的 manifest 合法性测试**

把下面这个测试追加到 `tests-ts/publish_contract.test.ts`：

```ts
import * as fs from "node:fs";
import * as path from "node:path";

const WORKSPACE_PACKAGE_JSONS = [
  "package.json",
  "packages/adapter-cc/package.json",
  "packages/adapter-oc/package.json",
  "packages/cli/package.json",
  "packages/shared/package.json",
  "packages/ssot-ts/package.json",
] as const;

test("all workspace package manifests are valid JSON", () => {
  const failures: string[] = [];

  for (const rel of WORKSPACE_PACKAGE_JSONS) {
    const text = fs.readFileSync(path.join(process.cwd(), rel), "utf-8");
    try {
      const parsed = JSON.parse(text) as { name?: unknown; version?: unknown };
      if (typeof parsed.name !== "string" || parsed.name.length === 0) {
        failures.push(`${rel}: missing string name`);
      }
      if (typeof parsed.version !== "string" || parsed.version.length === 0) {
        failures.push(`${rel}: missing string version`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${rel}: ${msg}`);
    }
  }

  expect(failures).toEqual([]);
});
```

若该文件在实现后已 import 了 `fs` 相关 helper，请合并 import，不要重复声明同名绑定。

- [ ] **步骤 2：跑这个聚焦测试**

运行：

```powershell
bun test tests-ts\publish_contract.test.ts
```

预期：PASS。若任务 1 未应用，本测试应失败，且报错信息会点名 `packages/ssot-ts/package.json`。

- [ ] **步骤 3：跑构建冒烟**

运行：

```powershell
npm run build
```

预期：构建能进到 package scripts，而不是卡在 JSON 解析。

- [ ] **步骤 4：提交 guard**

运行：

```powershell
git add tests-ts\publish_contract.test.ts
git commit -m "test: validate workspace package manifests"
```

预期：提交只包含本 manifest guard。

---

### 任务 3：新增只读导航投影

**文件：**
- 新建：`packages/ssot-ts/src/runtime/navigation_map.ts`
- 修改：`packages/ssot-ts/src/runtime/index.ts`
- 新建：`tests-ts/ssot/navigation_map.test.ts`

- [ ] **步骤 1：写聚焦的投影测试**

新建 `tests-ts/ssot/navigation_map.test.ts`：

```ts
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildNavigationMap,
  initRunDir,
  writeRunState,
  writeTaskPlan,
} from "../../packages/ssot-ts/src/runtime/index.js";
import { HumanPending, Phase, parseRunState } from "../../packages/ssot-ts/src/schema/run_state.js";
import { parseTaskPlan } from "../../packages/ssot-ts/src/schema/task_plan.js";

function makeRun(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loop-nav-"));
  const runDir = initRunDir(path.join(root, "runs"), "20260628-001", "req");
  writeRunState(
    runDir,
    parseRunState({ run_id: "20260628-001", complexity: "simple", phase: Phase.CREATED }),
  );
  return runDir;
}

test("navigation map treats human signoff as normal pending, not a blocker", () => {
  const runDir = makeRun();
  const state = parseRunState({
    run_id: "20260628-001",
    complexity: "simple",
    phase: Phase.PLANNING,
    human_pending: HumanPending.plan_signoff,
  });

  const map = buildNavigationMap(runDir, state, null);

  expect(map.current_phase).toBe(Phase.PLANNING);
  // 人盯锚点是 run 的正常停顿 (design 人盯点), 不是失败 → 不进 blocker, 单列 human_pending。
  expect(map.human_pending).toBe("plan_signoff");
  expect(map.blocker).toBeNull();
  expect(map.next_action).toBe("review the plan, then run signoff-plan or reject with feedback");
  // 等人签字时当前 phase 仍是 current (正常进行中), 不是 blocked。
  expect(map.phases.find((p) => p.phase === Phase.PLANNING)?.status).toBe("current");
});

test("navigation map points to plan-check-failures.json", () => {
  const runDir = makeRun();
  const failurePath = path.join(runDir, "planning", "plan-check-failures.json");
  fs.mkdirSync(path.dirname(failurePath), { recursive: true });
  fs.writeFileSync(
    failurePath,
    JSON.stringify([{ check: "ac_has_task_and_test", passed: false, detail: "AC-001 has no tests" }]),
    "utf-8",
  );
  const state = parseRunState({
    run_id: "20260628-001",
    complexity: "simple",
    phase: Phase.PLANNING,
  });

  const map = buildNavigationMap(runDir, state, null);

  expect(map.blocker?.kind).toBe("plan_check_failed");
  expect(map.blocker?.evidence_paths).toEqual(["planning/plan-check-failures.json"]);
  expect(map.next_action).toBe("fix planning/task-plan.yaml and rerun plan");
});

test("navigation map flags a running task that wrote collect-failures.json", () => {
  // 真实失败路径 (主 agent 的 dispatch + collect-outcome): 自检失败时 task 留 running、
  // 写 collect-failures.json, 不会翻 blocked (blocked 仅 tick watchdog 路径产生)。
  // 这是导航图必须能看见的最常见失败 —— 不能因为 task 仍是 running 就漏报。
  const runDir = makeRun();
  const plan = parseTaskPlan({
    complexity: "simple",
    tasks: [
      {
        id: "T01",
        title: "failing task",
        allowed_write_paths: ["src/**"],
        acceptance_refs: ["AC-001"],
        tests: [{ id: "case1", scenario: "happy path", checks: ["passed == true"] }],
        status: "running",
        attempt: 1,
      },
      {
        id: "T02",
        title: "pending task",
        allowed_write_paths: ["docs/**"],
        acceptance_refs: ["AC-002"],
        tests: [{ id: "case2", scenario: "docs path", checks: ["passed == true"] }],
        status: "pending",
        attempt: 0,
      },
    ],
  });
  writeTaskPlan(path.join(runDir, "planning", "task-plan.yaml"), plan);
  const failurePath = path.join(runDir, "tasks", "T01", "collect-failures.json");
  fs.mkdirSync(path.dirname(failurePath), { recursive: true });
  fs.writeFileSync(
    failurePath,
    JSON.stringify({
      task_id: "T01",
      reason: "task_check_fail",
      failures: [{ check: "tests_green", passed: false, detail: "tests failed" }],
      oob_paths: [],
      attempt: 1,
      collected_at: "2026-06-28T00:00:00.000Z",
    }),
    "utf-8",
  );
  const state = parseRunState({
    run_id: "20260628-001",
    complexity: "simple",
    phase: Phase.IMPLEMENTING,
    active_tasks: ["T01"],
  });

  const map = buildNavigationMap(runDir, state, plan);

  expect(map.task_summary).toEqual({
    pending: 1,
    running: 1,
    blocked: 0,
    complete: 0,
  });
  expect(map.blocker?.kind).toBe("task_failed");
  expect(map.blocker?.evidence_paths).toEqual(["tasks/T01/collect-failures.json"]);
  expect(map.next_action).toBe("inspect failed task evidence and dispatch a fix or abort");
});

test("navigation map flags a watchdog-blocked task", () => {
  // watchdog 路径 (dry-run tick 循环): 二次回收后 task 翻 blocked, 证据在 logs/watchdog.json。
  const runDir = makeRun();
  const plan = parseTaskPlan({
    complexity: "simple",
    tasks: [
      {
        id: "T01",
        title: "blocked task",
        allowed_write_paths: ["src/**"],
        acceptance_refs: ["AC-001"],
        tests: [{ id: "case1", scenario: "happy path", checks: ["passed == true"] }],
        status: "blocked",
        attempt: 2,
      },
    ],
  });
  writeTaskPlan(path.join(runDir, "planning", "task-plan.yaml"), plan);
  const wdPath = path.join(runDir, "tasks", "T01", "logs", "watchdog.json");
  fs.mkdirSync(path.dirname(wdPath), { recursive: true });
  fs.writeFileSync(wdPath, JSON.stringify([{ reason: "timeout" }]), "utf-8");
  const state = parseRunState({
    run_id: "20260628-001",
    complexity: "simple",
    phase: Phase.IMPLEMENTING,
  });

  const map = buildNavigationMap(runDir, state, plan);

  expect(map.task_summary.blocked).toBe(1);
  expect(map.blocker?.kind).toBe("task_failed");
  expect(map.blocker?.evidence_paths).toEqual(["tasks/T01/logs/watchdog.json"]);
});
```

- [ ] **步骤 2：跑新测试并确认它失败**

运行：

```powershell
bun test tests-ts\ssot\navigation_map.test.ts
```

预期：FAIL，因为 `buildNavigationMap` 尚未导出。

- [ ] **步骤 3：创建投影模块**

新建 `packages/ssot-ts/src/runtime/navigation_map.ts`：

```ts
import * as fs from "node:fs";
import * as path from "node:path";

import { Phase, type RunState } from "../schema/run_state.js";
import { TaskStatus, type TaskPlan } from "../schema/task_plan.js";

export type NavigationPhaseStatus = "done" | "current" | "blocked" | "pending";

export interface NavigationPhase {
  readonly phase: Phase;
  readonly status: NavigationPhaseStatus;
  readonly detail: string;
  readonly evidence_paths: string[];
}

/**
 * blocker 只表示"真异常/真失败", 不含人盯锚点。
 * human_pending (plan_signoff / wrap_up_signoff) 是 run 的正常停顿, 单列在 NavigationMap.human_pending。
 */
export interface NavigationBlocker {
  readonly kind:
    | "aborted"
    | "plan_check_failed"
    | "task_failed"
    | "wrap_up_failed";
  readonly reason: string;
  readonly evidence_paths: string[];
}

export interface NavigationTaskSummary {
  readonly pending: number;
  readonly running: number;
  readonly blocked: number;
  readonly complete: number;
}

export interface NavigationMap {
  readonly run_id: string;
  readonly current_phase: Phase;
  readonly human_pending: string | null;
  readonly task_summary: NavigationTaskSummary;
  readonly blocker: NavigationBlocker | null;
  readonly next_action: string;
  readonly phases: NavigationPhase[];
}

const PHASE_ORDER: readonly Phase[] = [
  Phase.CREATED,
  Phase.CLARIFYING,
  Phase.PLANNING,
  Phase.IMPLEMENTING,
  Phase.WRAPPING_UP,
  Phase.COMPLETE,
];

function relEvidence(runDir: string, parts: string[]): string[] {
  return parts.filter((p) => fs.existsSync(path.join(runDir, p)));
}

function summarizeTasks(plan: TaskPlan | null): NavigationTaskSummary {
  const summary = { pending: 0, running: 0, blocked: 0, complete: 0 };
  if (plan === null) return summary;
  for (const task of plan.tasks) {
    if (task.status === TaskStatus.pending) summary.pending += 1;
    if (task.status === TaskStatus.running) summary.running += 1;
    if (task.status === TaskStatus.blocked) summary.blocked += 1;
    if (task.status === TaskStatus.complete) summary.complete += 1;
  }
  return summary;
}

/**
 * 找第一个"失败"的 task 及其证据。覆盖两条真实失败路径:
 * - dispatch/collect 路径 (主 agent 真实 run): 自检失败 → task 留 running + 写
 *   collect-failures.json (coordinator.ts collectTaskOutcome 分支3, 不翻 blocked)。
 * - tick watchdog 路径 (dry-run): 二次回收 → task 翻 blocked (logs/watchdog.json)。
 * 正常 running 且无 collect-failures.json 不算失败 (worker 仍在跑), 避免误报。
 */
function firstFailedTask(
  runDir: string,
  plan: TaskPlan | null,
): { id: string; evidence: string[] } | null {
  if (plan === null) return null;
  for (const task of plan.tasks) {
    const cf = path.join("tasks", task.id, "collect-failures.json");
    const wd = path.join("tasks", task.id, "logs", "watchdog.json");
    if (task.status === TaskStatus.blocked) {
      const existing = relEvidence(runDir, [cf, wd]);
      return { id: task.id, evidence: existing.length > 0 ? existing : [cf] };
    }
    if (
      task.status === TaskStatus.running &&
      fs.existsSync(path.join(runDir, cf))
    ) {
      return { id: task.id, evidence: [cf] };
    }
  }
  return null;
}

function wrapUpFailures(runDir: string): string[] {
  const rel = "wrap-up/check-result.json";
  const abs = path.join(runDir, rel);
  if (!fs.existsSync(abs)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(abs, "utf-8")) as Array<{ passed?: boolean }>;
    return parsed.some((item) => item.passed === false) ? [rel] : [];
  } catch {
    return [rel];
  }
}

function detectBlocker(
  runDir: string,
  state: RunState,
  plan: TaskPlan | null,
): NavigationBlocker | null {
  if (state.phase === Phase.ABORTED) {
    return {
      kind: "aborted",
      reason: state.aborted_reason ?? "run aborted",
      evidence_paths: ["run-state.json"],
    };
  }
  // 注意: human_pending 不是 blocker (它是正常人盯锚点), 这里不处理。
  // plan 自检失败: 仅当 PLANNING 且尚未通过 (human_pending 为空)。
  // 通过后会 set human_pending=plan_signoff, 但 plan-check-failures.json 不会被删除,
  // 故用 human_pending 为空区分"仍失败"与"已通过等签字" (否则旧失败文件会误报)。
  const planFailures = relEvidence(runDir, ["planning/plan-check-failures.json"]);
  if (
    planFailures.length > 0 &&
    state.phase === Phase.PLANNING &&
    (state.human_pending === null || state.human_pending === undefined)
  ) {
    return {
      kind: "plan_check_failed",
      reason: "planning gate failed",
      evidence_paths: planFailures,
    };
  }
  // task 失败 (两条路径): running+collect-failures.json 或 watchdog blocked。
  if (state.phase === Phase.IMPLEMENTING) {
    const failed = firstFailedTask(runDir, plan);
    if (failed !== null) {
      return {
        kind: "task_failed",
        reason: `task ${failed.id} failed`,
        evidence_paths: failed.evidence,
      };
    }
  }
  // wrap-up 失败: 即使 human_pending=wrap_up_signoff 也并存上报,
  // 让 operator 知道"去签字, 但收口自检没过, 应 reject"。
  const wrapFailures = wrapUpFailures(runDir);
  if (state.phase === Phase.WRAPPING_UP && wrapFailures.length > 0) {
    return {
      kind: "wrap_up_failed",
      reason: "wrap-up gate failed",
      evidence_paths: wrapFailures,
    };
  }
  return null;
}

function nextAction(state: RunState, blocker: NavigationBlocker | null): string {
  if (state.phase === Phase.ABORTED) return "inspect aborted_reason and start a new run if needed";
  // 收口失败优先于"去签字": 引导 reject 而非误签。
  if (blocker?.kind === "wrap_up_failed") {
    return "reject wrap-up, return to IMPLEMENTING, and repair failing evidence";
  }
  // 人盯锚点是正常下一步 (非失败)。
  if (state.human_pending === "wrap_up_signoff") {
    return "review wrap-up evidence, then run signoff-wrap-up or reject";
  }
  if (state.human_pending === "plan_signoff") {
    return "review the plan, then run signoff-plan or reject with feedback";
  }
  if (blocker?.kind === "plan_check_failed") return "fix planning/task-plan.yaml and rerun plan";
  if (blocker?.kind === "task_failed") return "inspect failed task evidence and dispatch a fix or abort";
  if (state.phase === Phase.CREATED) return "run plan with design and task-plan inputs";
  if (state.phase === Phase.PLANNING) return "submit or repair the plan";
  if (state.phase === Phase.IMPLEMENTING) return "dispatch ready tasks or collect running task outcomes";
  if (state.phase === Phase.WRAPPING_UP) return "review wrap-up evidence";
  if (state.phase === Phase.COMPLETE) return "run complete";
  return "continue lifecycle";
}

function phaseDetail(phase: Phase, state: RunState, summary: NavigationTaskSummary): string {
  if (phase === Phase.CREATED) return "run initialized";
  if (phase === Phase.CLARIFYING) return "optional clarification phase";
  if (phase === Phase.PLANNING) return state.human_pending === "plan_signoff" ? "waiting for plan signoff" : "planning evidence";
  if (phase === Phase.IMPLEMENTING) {
    return `tasks pending=${summary.pending}, running=${summary.running}, blocked=${summary.blocked}, complete=${summary.complete}`;
  }
  if (phase === Phase.WRAPPING_UP) return state.human_pending === "wrap_up_signoff" ? "waiting for wrap-up signoff" : "wrap-up evidence";
  if (phase === Phase.COMPLETE) return "terminal success";
  return "terminal abort";
}

export function buildNavigationMap(
  runDir: string,
  state: RunState,
  plan: TaskPlan | null,
): NavigationMap {
  const summary = summarizeTasks(plan);
  const blocker = detectBlocker(runDir, state, plan);
  const currentIndex = PHASE_ORDER.indexOf(state.phase);
  const phases = PHASE_ORDER.map((phase, idx): NavigationPhase => {
    const status: NavigationPhaseStatus =
      state.phase === Phase.ABORTED
        ? "pending"
        : idx < currentIndex
          ? "done"
          : idx === currentIndex
            ? blocker === null
              ? "current"
              : "blocked"
            : "pending";
    return {
      phase,
      status,
      detail: phaseDetail(phase, state, summary),
      evidence_paths: relEvidence(runDir, evidenceCandidatesForPhase(phase)),
    };
  });

  if (state.phase === Phase.ABORTED) {
    phases.push({
      phase: Phase.ABORTED,
      status: "blocked",
      detail: state.aborted_reason ?? "run aborted",
      evidence_paths: ["run-state.json"],
    });
  }

  return {
    run_id: state.run_id,
    current_phase: state.phase,
    human_pending: state.human_pending ?? null,
    task_summary: summary,
    blocker,
    next_action: nextAction(state, blocker),
    phases,
  };
}

function evidenceCandidatesForPhase(phase: Phase): string[] {
  if (phase === Phase.CREATED) return ["input/requirement.md", "run-state.json"];
  if (phase === Phase.CLARIFYING) return ["clarification/questions.json", "clarification/answers.json"];
  if (phase === Phase.PLANNING) return ["planning/design.md", "planning/task-plan.yaml", "planning/plan-check-failures.json"];
  if (phase === Phase.IMPLEMENTING) return ["tasks"];
  if (phase === Phase.WRAPPING_UP) return ["wrap-up/check-result.json"];
  if (phase === Phase.COMPLETE) return ["run-state.json"];
  return ["run-state.json"];
}
```

- [ ] **步骤 4：导出投影 API**

把这行导出追加到 `packages/ssot-ts/src/runtime/index.ts`：

```ts
export * from "./navigation_map.js";
```

- [ ] **步骤 5：跑聚焦测试**

运行：

```powershell
bun test tests-ts\ssot\navigation_map.test.ts
```

预期：PASS。

- [ ] **步骤 6：提交投影模块**

运行：

```powershell
git add packages\ssot-ts\src\runtime\navigation_map.ts packages\ssot-ts\src\runtime\index.ts tests-ts\ssot\navigation_map.test.ts
git commit -m "feat: add runtime navigation map projection"
```

预期：提交只包含投影模块与其聚焦单测。

---

### 任务 4：在 `status` 中渲染导航图

**文件：**
- 修改：`packages/cli/src/commands/dryrun.ts`
- 修改：`tests-ts/integration_dry_run.test.ts`

- [ ] **步骤 1：补 CLI import**

在 `packages/cli/src/commands/dryrun.ts` 中扩展 runtime import：

```ts
import {
  Coordinator,
  buildNavigationMap,
  initRunDir,
  nextRunId,
  readRunState,
  readTaskPlan,
  writeRunState,
  writeTaskPlan,
  type CollectCliResult,
} from "@e2e-loop/ssot/runtime";
```

- [ ] **步骤 2：加一个紧凑渲染器**

在 `humanPendingText` 附近加这个 helper：

```ts
function renderNavigationMap(
  map: ReturnType<typeof buildNavigationMap>,
): string {
  const lines: string[] = [];
  lines.push("navigation_map:");
  for (const p of map.phases) {
    const evidence =
      p.evidence_paths.length > 0 ? ` evidence=${JSON.stringify(p.evidence_paths)}` : "";
    lines.push(`  - ${p.phase}: ${p.status} - ${p.detail}${evidence}`);
  }
  if (map.blocker !== null) {
    lines.push(`blocker: ${map.blocker.kind} - ${map.blocker.reason}`);
    if (map.blocker.evidence_paths.length > 0) {
      lines.push(`blocker_evidence: ${JSON.stringify(map.blocker.evidence_paths)}`);
    }
  } else {
    lines.push("blocker: (none)");
  }
  lines.push(`next_action: ${map.next_action}`);
  return `${lines.join("\n")}\n`;
}
```

- [ ] **步骤 3：接进 `runStatus`**

把 `runStatus` 末尾（既有 abort 字段之后）替换为：

```ts
  let plan = null;
  const planPath = path.join(runDir, "planning", "task-plan.yaml");
  if (fs.existsSync(planPath)) {
    try {
      plan = readTaskPlan(planPath);
    } catch {
      plan = null;
    }
  }
  process.stdout.write(renderNavigationMap(buildNavigationMap(runDir, state, plan)));
  return 0;
```

保持既有的 `run_id`、`phase`、`complexity`、`trust_mode`、`human_pending`、`active_tasks`、`aborted_reason` 各行原样不动。

- [ ] **步骤 4：加 CLI 集成断言**

在 `tests-ts/integration_dry_run.test.ts` 中扩展末尾的 `status` 断言：

```ts
    const statusOut = run("status", runId);
    expect(statusOut).toContain("phase: IMPLEMENTING");
    expect(statusOut).toContain("navigation_map:");
    expect(statusOut).toContain("IMPLEMENTING:");
    expect(statusOut).toContain("next_action:");
```

- [ ] **步骤 5：跑这个聚焦集成测试**

运行：

```powershell
bun test tests-ts\integration_dry_run.test.ts
```

预期：PASS。

- [ ] **步骤 6：提交 status 渲染**

运行：

```powershell
git add packages\cli\src\commands\dryrun.ts tests-ts\integration_dry_run.test.ts
git commit -m "feat: show navigation map in status"
```

预期：提交只包含 CLI 渲染与 CLI 集成断言。

---

### 任务 5：完整验证与残留检查

**文件：**
- 无新增文件。
- 校验任务 1 到 4 改动过的所有文件。

- [ ] **步骤 1：先跑聚焦检查**

运行：

```powershell
bun test tests-ts\publish_contract.test.ts tests-ts\ssot\navigation_map.test.ts tests-ts\integration_dry_run.test.ts
```

预期：PASS。

- [ ] **步骤 2：跑构建**

运行：

```powershell
npm run build
```

预期：PASS。

- [ ] **步骤 3：跑全量测试套件**

运行：

```powershell
npm test
```

预期：PASS。若出现无关失败，先记录失败文件名与确切的首条失败信息，再动代码。

- [ ] **步骤 4：检查 git diff 的范围**

运行：

```powershell
git diff --stat
git diff -- packages\ssot-ts\package.json tests-ts\publish_contract.test.ts packages\ssot-ts\src\runtime\navigation_map.ts packages\ssot-ts\src\runtime\index.ts packages\cli\src\commands\dryrun.ts tests-ts\ssot\navigation_map.test.ts tests-ts\integration_dry_run.test.ts
```

预期：只有计划内的文件被改动。

- [ ] **步骤 5：若任务 1 到 4 未分别提交，则做最终提交**

运行：

```powershell
git add packages\ssot-ts\package.json tests-ts\publish_contract.test.ts packages\ssot-ts\src\runtime\navigation_map.ts packages\ssot-ts\src\runtime\index.ts packages\cli\src\commands\dryrun.ts tests-ts\ssot\navigation_map.test.ts tests-ts\integration_dry_run.test.ts
git commit -m "feat: add status navigation map"
```

预期：构建与测试通过后提交成功。

---

## 自检 (Self-Review)

- 规格覆盖：manifest 任务现在是"校验并加固"步骤（工作树已是合法 JSON、`npm run build` 为绿、`./worktree` 导出完好）；任务 2 为 package manifest 增加回归 guard；导航图为 P1 只读投影。
- 状态归属：导航图只读取既有状态与证据文件；不写生命周期状态，也不改调度器行为。
- 人盯锚点 vs 失败：`human_pending`（plan_signoff / wrap_up_signoff）是正常停顿点，经 `NavigationMap.human_pending` 与 `next_action` 呈现，**不是** `blocker`。等人期间当前 phase 保持 `current`。`blocker` 只保留真失败：`aborted`、`plan_check_failed`、`task_failed`、`wrap_up_failed`。
- 失败定位精度：导航图覆盖 IMPLEMENTING 下的**两条**真实失败路径——task 留 `running` 且写了 `collect-failures.json`（主 agent 实际走的 dispatch/collect 路径）与 `blocked` task（tick watchdog 路径）——均经 `firstFailedTask`。`plan_check_failed` 以 `human_pending` 为空为前提，避免已通过、正等签字的计划被一份残留的 `plan-check-failures.json` 误报。既有的 `collect-failures.json`、`plan-check-failures.json`、`wrap-up/check-result.json` 与 `aborted_reason` 仍是事实源；导航图指向它们，而非复制其内容。
- 类型一致性：`buildNavigationMap(runDir, state, plan)` 从 `@e2e-loop/ssot/runtime` 导出，并由 CLI `status` 渲染。
- 测试路径：本计划跑聚焦 Bun 测试、`npm run build` 与全量 `npm test`。任务 5 必须确认没有别的测试对 `status` 全量输出做精确断言——新增行之后只有 `toContain` 是安全的（当前 `integration_dry_run.test.ts` 与 `integration_dispatch_collect.test.ts` 都用的 `toContain`）。
