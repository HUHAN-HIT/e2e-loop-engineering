# Failure Reason And Navigation Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the workspace manifests valid (the build is currently green), prevent malformed package manifests from reaching integration tests, and add a read-only navigation map to `e2e-loop status`.

**Architecture:** Keep `run-state.json` and `task-plan.yaml` as the only state sources. Add a pure runtime projection module that reads existing state and evidence files, then have the CLI render that projection without changing scheduling, gates, or task state.

**Tech Stack:** TypeScript, Bun test, Node.js `fs/path`, existing `@e2e-loop/ssot` runtime exports, existing `e2e-loop` CLI.

---

## Scope And Priority

This plan intentionally separates the immediate failure from operator UX:

- P0: Verify `packages/ssot-ts/package.json` is valid JSON (repair only if corrupted), preserving the `./worktree` subpath export. As of 2026-06-28 the manifest is already valid and `npm run build` exits 0, so this is a verify-and-guard step, not a repair.
- P0.5: Add a manifest guard so invalid workspace package JSON fails near the start of the test suite.
- P1: Add a read-only navigation map projection to `status`.

The navigation map must not introduce a second state source. It is a display/projection layer over existing files only.

## File Structure

- Modify: `packages/ssot-ts/package.json`
  - Responsibility: valid workspace package metadata.
- Modify: `tests-ts/publish_contract.test.ts`
  - Responsibility: publish/package manifest contract checks.
- Create: `packages/ssot-ts/src/runtime/navigation_map.ts`
  - Responsibility: pure projection from `RunState`, optional `TaskPlan`, and evidence files to a compact operator map.
- Modify: `packages/ssot-ts/src/runtime/index.ts`
  - Responsibility: export the new runtime projection API.
- Modify: `packages/cli/src/commands/dryrun.ts`
  - Responsibility: render the navigation map from `status`.
- Create: `tests-ts/ssot/navigation_map.test.ts`
  - Responsibility: focused unit tests for the projection.
- Modify: `tests-ts/integration_dry_run.test.ts`
  - Responsibility: CLI-level assertion that `status` exposes the map.

---

### Task 1: Repair The Invalid Workspace Manifest

**Files:**
- Modify: `packages/ssot-ts/package.json`

- [ ] **Step 1: Inspect the manifest**

Run:

```powershell
Get-Content packages\ssot-ts\package.json
```

Expected (current tree): the file is already valid JSON and includes a `"./worktree": "./src/worktree/index.ts"` export. Proceed to Step 2 to repair **only if** the `description` field shows mojibake/control-character corruption or the JSON does not close. Otherwise treat Steps 2-4 as a no-op confirmation and move to Task 2.

- [ ] **Step 2: (Only if Step 1 found corruption) Restore valid JSON**

CRITICAL: keep the `"./worktree": "./src/worktree/index.ts"` export — dropping it breaks every `@e2e-loop/ssot/worktree` consumer (e.g. `packages/cli/src/commands/dryrun.ts`) and the worktree tests. If you must rewrite the file, it should read exactly (this matches the current valid tree):

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

- [ ] **Step 3: Verify npm can parse the workspace**

Run:

```powershell
npm run build
```

Expected: `npm run build` exits 0 (the manifest parses; on the current tree this already holds). Any later TypeScript/build error is a separate issue and should be evaluated from its own message.

- [ ] **Step 4: Commit this repair separately (skip if Step 1 found no corruption)**

If Step 2 changed the file, run:

```powershell
git add packages\ssot-ts\package.json
git commit -m "fix: repair ssot package manifest"
```

Expected: commit succeeds with only `packages/ssot-ts/package.json` staged. If the manifest was already valid, there is nothing to stage — skip this commit.

---

### Task 2: Add A Workspace Manifest Guard

**Files:**
- Modify: `tests-ts/publish_contract.test.ts`

- [ ] **Step 1: Write a failing manifest validity test**

Append this test to `tests-ts/publish_contract.test.ts`:

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

If the file already imports `fs` helpers after implementation, merge imports rather than duplicating names.

- [ ] **Step 2: Run the focused test**

Run:

```powershell
bun test tests-ts\publish_contract.test.ts
```

Expected: PASS. If Task 1 was not applied, this test should fail with a message naming `packages/ssot-ts/package.json`.

- [ ] **Step 3: Run the build smoke**

Run:

```powershell
npm run build
```

Expected: build reaches package scripts instead of stopping at JSON parsing.

- [ ] **Step 4: Commit the guard**

Run:

```powershell
git add tests-ts\publish_contract.test.ts
git commit -m "test: validate workspace package manifests"
```

Expected: commit contains only the manifest guard.

---

### Task 3: Add The Read-Only Navigation Projection

**Files:**
- Create: `packages/ssot-ts/src/runtime/navigation_map.ts`
- Modify: `packages/ssot-ts/src/runtime/index.ts`
- Create: `tests-ts/ssot/navigation_map.test.ts`

- [ ] **Step 1: Write focused projection tests**

Create `tests-ts/ssot/navigation_map.test.ts`:

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

- [ ] **Step 2: Run the new test and confirm it fails**

Run:

```powershell
bun test tests-ts\ssot\navigation_map.test.ts
```

Expected: FAIL because `buildNavigationMap` is not exported.

- [ ] **Step 3: Create the projection module**

Create `packages/ssot-ts/src/runtime/navigation_map.ts`:

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

- [ ] **Step 4: Export the projection API**

Append this export to `packages/ssot-ts/src/runtime/index.ts`:

```ts
export * from "./navigation_map.js";
```

- [ ] **Step 5: Run focused tests**

Run:

```powershell
bun test tests-ts\ssot\navigation_map.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the projection**

Run:

```powershell
git add packages\ssot-ts\src\runtime\navigation_map.ts packages\ssot-ts\src\runtime\index.ts tests-ts\ssot\navigation_map.test.ts
git commit -m "feat: add runtime navigation map projection"
```

Expected: commit contains only the projection and focused unit tests.

---

### Task 4: Render Navigation Map In `status`

**Files:**
- Modify: `packages/cli/src/commands/dryrun.ts`
- Modify: `tests-ts/integration_dry_run.test.ts`

- [ ] **Step 1: Add the CLI import**

In `packages/cli/src/commands/dryrun.ts`, extend the runtime import:

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

- [ ] **Step 2: Add a compact renderer**

Add this helper near `humanPendingText`:

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

- [ ] **Step 3: Wire it into `runStatus`**

Replace the end of `runStatus` after the existing abort fields with:

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

Keep the existing `run_id`, `phase`, `complexity`, `trust_mode`, `human_pending`, `active_tasks`, and `aborted_reason` lines intact.

- [ ] **Step 4: Add CLI integration assertions**

In `tests-ts/integration_dry_run.test.ts`, extend the final `status` assertions:

```ts
    const statusOut = run("status", runId);
    expect(statusOut).toContain("phase: IMPLEMENTING");
    expect(statusOut).toContain("navigation_map:");
    expect(statusOut).toContain("IMPLEMENTING:");
    expect(statusOut).toContain("next_action:");
```

- [ ] **Step 5: Run the focused integration test**

Run:

```powershell
bun test tests-ts\integration_dry_run.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the status rendering**

Run:

```powershell
git add packages\cli\src\commands\dryrun.ts tests-ts\integration_dry_run.test.ts
git commit -m "feat: show navigation map in status"
```

Expected: commit contains only CLI rendering and CLI integration assertions.

---

### Task 5: Full Verification And Residual Checks

**Files:**
- No new files.
- Validate all files changed by Tasks 1 through 4.

- [ ] **Step 1: Run focused checks first**

Run:

```powershell
bun test tests-ts\publish_contract.test.ts tests-ts\ssot\navigation_map.test.ts tests-ts\integration_dry_run.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run build**

Run:

```powershell
npm run build
```

Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run:

```powershell
npm test
```

Expected: PASS. If unrelated failures appear, capture the failing file names and exact first failure message before changing code.

- [ ] **Step 4: Inspect git diff for scope**

Run:

```powershell
git diff --stat
git diff -- packages\ssot-ts\package.json tests-ts\publish_contract.test.ts packages\ssot-ts\src\runtime\navigation_map.ts packages\ssot-ts\src\runtime\index.ts packages\cli\src\commands\dryrun.ts tests-ts\ssot\navigation_map.test.ts tests-ts\integration_dry_run.test.ts
```

Expected: only the planned files changed.

- [ ] **Step 5: Final commit if Tasks 1 to 4 were not committed separately**

Run:

```powershell
git add packages\ssot-ts\package.json tests-ts\publish_contract.test.ts packages\ssot-ts\src\runtime\navigation_map.ts packages\ssot-ts\src\runtime\index.ts packages\cli\src\commands\dryrun.ts tests-ts\ssot\navigation_map.test.ts tests-ts\integration_dry_run.test.ts
git commit -m "feat: add status navigation map"
```

Expected: commit succeeds after build and tests pass.

---

## Self-Review

- Spec coverage: The manifest task is now a verify-and-guard step (the tree is already valid JSON with `npm run build` green and the `./worktree` export intact), Task 2 adds a regression guard for package manifests, and the navigation map is a P1 read-only projection.
- State ownership: The navigation map reads existing state and evidence files only; it does not write lifecycle state or alter scheduler behavior.
- Human anchors vs failures: `human_pending` (plan_signoff / wrap_up_signoff) is a normal stop point, surfaced via `NavigationMap.human_pending` and `next_action`, and is NOT a `blocker`. The current phase stays `current` while waiting for a human. `blocker` is reserved for real failures: `aborted`, `plan_check_failed`, `task_failed`, `wrap_up_failed`.
- Failure specificity: The map covers BOTH real failure paths in IMPLEMENTING — a task left `running` with `collect-failures.json` (the dispatch/collect path the main agent actually uses) and a `blocked` task (tick watchdog path) — via `firstFailedTask`. `plan_check_failed` is gated on `human_pending` being empty so a stale `plan-check-failures.json` does not misreport a plan that already passed and is awaiting signoff. Existing `collect-failures.json`, `plan-check-failures.json`, `wrap-up/check-result.json`, and `aborted_reason` remain the source of truth; the map points to them rather than duplicating content.
- Type consistency: `buildNavigationMap(runDir, state, plan)` is exported from `@e2e-loop/ssot/runtime` and rendered by CLI `status`.
- Test path: The plan runs focused Bun tests, `npm run build`, and the full `npm test` suite. Task 5 must confirm no other test asserts the full `status` output verbatim — only `toContain` is safe after the new lines (current `integration_dry_run.test.ts` and `integration_dispatch_collect.test.ts` use `toContain`).
