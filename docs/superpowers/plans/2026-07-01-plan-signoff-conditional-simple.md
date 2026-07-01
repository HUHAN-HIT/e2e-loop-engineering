# Plan 拍板条件锚点化 (simple 免签) 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `complexity=simple` 且未触发风险闸、未强制门禁的 run 在 `plan_check` 通过后自动接受计划进入 IMPLEMENTING(免签),其余 run 保留人工 `plan_signoff`;免签路径写独立诚实审计标记,绝不记为"人已签署"。

**Architecture:** 新增纯判据函数 `shouldAutoAcceptPlan`,由 `Coordinator.submitPlan` 在 `plan_check` 通过后调用做分叉——与现有 `submitWrapUp` 的条件锚点判据(`risk:high`/`exclusive` 一票否决)完全同构,额外加复杂度闸(仅 simple)、契约闸、opt-out 开关。行为落在 TS SSOT + SKILL 文本两处,不涉及 CC/OC binding 分叉。

**Tech Stack:** TypeScript + zod(schema)+ js-yaml;测试 `npx bun test tests-ts/`;类型检查 `npx tsc --noEmit`;构建 `npm run build`。

## Global Constraints

- 代码注释统一用中文(与现有 SSOT 风格一致)。
- 测试工具链:`npx bun test tests-ts/`(经 `npx bun@1.3.14`);类型:`npx tsc --noEmit`,零报错。
- 免签路径任何输出/日志/标记**禁止**出现"已签署""已拍板""signed off";只用"自动接受(免签)""auto-accepted"。
- 免签路径**绝不**调 `setHumanPending`,**绝不**复用 `signoffPlan`。
- 不满足免签 → 完全走现有 `plan_signoff` 老路,零回归。
- 复杂度取 `state.complexity`(run 级权威);风险闸看 `plan.tasks` 的 `risk`/`exclusive`;契约闸看 `planning/service-contracts.yaml` 是否存在。
- 每个任务末尾 commit;commit message 中文,结尾附 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
- 规范源:`docs/superpowers/specs/2026-07-01-plan-signoff-conditional-simple-design.md`。

---

## 文件结构

- **改** `packages/ssot-ts/src/schema/run_state.ts` — `RunConfigSchema` 加 `require_plan_signoff` 字段。
- **建** `packages/ssot-ts/src/state_machine/plan_auto_accept.ts` — 纯判据函数 `shouldAutoAcceptPlan`。
- **改** `packages/ssot-ts/src/state_machine/index.ts` — 导出新模块。
- **改** `packages/ssot-ts/src/runtime/coordinator.ts` — `submitPlan` 分叉 + 私有 `writePlanAutoAccepted`。
- **建** `tests-ts/ssot/plan_auto_accept.test.ts` — 纯函数真值表。
- **建** `tests-ts/ssot/coordinator_plan_auto_accept.test.ts` — submitPlan 分支集成测试。
- **改** `tests-ts/ssot/schema_run_state.test.ts` — 新配置字段默认/round-trip。
- **改** 现有回归测试(注入 `require_plan_signoff:true` 或改断言):`coordinator_plan_restore.test.ts` / `coordinator_dispatch_collect.test.ts` / `integration_dry_run.test.ts` / `integration_dispatch_collect.test.ts`。
- **改** `packages/cli/src/commands/dryrun.ts` — `plan` 命令加免签说明行;`init` 加 `--require-plan-signoff` flag。
- **改** `packages/cli/src/args.ts` — 注册 `--require-plan-signoff` flag(若需)。
- **改** `tests-ts/guard_anchors.test.ts` — 免签后 IMPLEMENTING pending → deny 催继续。
- **改** `core/coordinator.md` — §2/§7/§末尾方法论文本。
- **改** `docs/loop-engineering-collaborative-design.md` / `docs/loop-engineering-master-prompt.md` / `docs/loop-engineering-prompts.md` — 方法论演进注。
- **改** `changlog.md` — 记本次改动。

---

## Task 1: schema 加 `require_plan_signoff` 配置字段

**Files:**
- Modify: `packages/ssot-ts/src/schema/run_state.ts:108-113`(`RunConfigSchema`)
- Test: `tests-ts/ssot/schema_run_state.test.ts`

**Interfaces:**
- Produces: `RunConfig.require_plan_signoff: boolean`(默认 `false`),供 Task 2/3 消费。

- [ ] **Step 1: 写失败测试**(在 `tests-ts/ssot/schema_run_state.test.ts` 末尾追加)

```ts
import { RunConfigSchema } from "../../packages/ssot-ts/src/schema/run_state.js";

test("[新增] RunConfig.require_plan_signoff 默认 false, 可 round-trip true", () => {
  const def = RunConfigSchema.parse({});
  expect(def.require_plan_signoff).toBe(false);
  const on = RunConfigSchema.parse({ require_plan_signoff: true });
  expect(on.require_plan_signoff).toBe(true);
});
```

（若文件顶部已 import 过 `RunConfigSchema` 则不重复 import。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx bun test tests-ts/ssot/schema_run_state.test.ts`
Expected: FAIL —— `require_plan_signoff` 为 `undefined`(字段未定义)。

- [ ] **Step 3: 加字段**

`packages/ssot-ts/src/schema/run_state.ts` 的 `RunConfigSchema`:

```ts
export const RunConfigSchema = z.object({
  watchdog_timeout_min: WatchdogTimeoutsSchema.default({}),
  max_retries_per_task: z.number().int().default(1),
  max_concurrency: z.number().int().default(4),
  // opt-out 开关: true → 强制恢复人工 plan 拍板 (即便 simple 免签条件满足)。默认 false = 默认免签。
  require_plan_signoff: z.boolean().default(false),
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx bun test tests-ts/ssot/schema_run_state.test.ts`
Expected: PASS。

- [ ] **Step 5: commit**

```bash
git add packages/ssot-ts/src/schema/run_state.ts tests-ts/ssot/schema_run_state.test.ts
git commit -m "feat(schema): RunConfig 增 require_plan_signoff 开关 (默认 false)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: 纯判据函数 `shouldAutoAcceptPlan`

**Files:**
- Create: `packages/ssot-ts/src/state_machine/plan_auto_accept.ts`
- Modify: `packages/ssot-ts/src/state_machine/index.ts:8-9`
- Test: `tests-ts/ssot/plan_auto_accept.test.ts`

**Interfaces:**
- Consumes: `Task`(`schema/task_plan.js`)、`Complexity`(`schema/run_state.js`)、`RiskLevel`(`schema/task_plan.js`)。
- Produces:
  ```ts
  interface AutoAcceptInput { complexity: Complexity; tasks: readonly Task[]; requirePlanSignoff: boolean; hasServiceContracts: boolean; }
  function shouldAutoAcceptPlan(input: AutoAcceptInput): boolean
  ```
  供 Task 3 的 `Coordinator.submitPlan` 消费。

- [ ] **Step 1: 写失败测试** `tests-ts/ssot/plan_auto_accept.test.ts`

```ts
/**
 * shouldAutoAcceptPlan 真值表 (spec 2026-07-01)。
 * 免签 ⟺ simple ∧ !requirePlanSignoff ∧ 无 risk:high ∧ 无 exclusive ∧ 无契约。
 */
import { test, expect } from "bun:test";
import { shouldAutoAcceptPlan } from "../../packages/ssot-ts/src/state_machine/plan_auto_accept.js";
import { parseTaskPlan } from "../../packages/ssot-ts/src/schema/task_plan.js";
import type { Task } from "../../packages/ssot-ts/src/schema/task_plan.js";

/** 造 task 列表: 默认 1 个 normal/非 exclusive task。 */
function tasks(opts?: { riskHigh?: boolean; exclusive?: boolean }): Task[] {
  return parseTaskPlan({
    complexity: "simple",
    tasks: [
      {
        id: "T01",
        title: "t",
        allowed_write_paths: ["src/**"],
        acceptance_refs: ["AC-001"],
        risk: opts?.riskHigh ? "high" : "normal",
        exclusive: opts?.exclusive ?? false,
      },
    ],
  }).tasks;
}

test("simple + 无风险闸 + config=false → 免签 true", () => {
  expect(
    shouldAutoAcceptPlan({
      complexity: "simple",
      tasks: tasks(),
      requirePlanSignoff: false,
      hasServiceContracts: false,
    }),
  ).toBe(true);
});

test("medium / complex → 不免签", () => {
  for (const c of ["medium", "complex"] as const) {
    expect(
      shouldAutoAcceptPlan({
        complexity: c,
        tasks: tasks(),
        requirePlanSignoff: false,
        hasServiceContracts: false,
      }),
    ).toBe(false);
  }
});

test("simple + require_plan_signoff=true → 不免签 (opt-out 开关)", () => {
  expect(
    shouldAutoAcceptPlan({
      complexity: "simple",
      tasks: tasks(),
      requirePlanSignoff: true,
      hasServiceContracts: false,
    }),
  ).toBe(false);
});

test("simple + risk:high task → 不免签 (风险闸①)", () => {
  expect(
    shouldAutoAcceptPlan({
      complexity: "simple",
      tasks: tasks({ riskHigh: true }),
      requirePlanSignoff: false,
      hasServiceContracts: false,
    }),
  ).toBe(false);
});

test("simple + exclusive task → 不免签 (风险闸②)", () => {
  expect(
    shouldAutoAcceptPlan({
      complexity: "simple",
      tasks: tasks({ exclusive: true }),
      requirePlanSignoff: false,
      hasServiceContracts: false,
    }),
  ).toBe(false);
});

test("simple + 存在 service-contracts → 不免签 (风险闸③)", () => {
  expect(
    shouldAutoAcceptPlan({
      complexity: "simple",
      tasks: tasks(),
      requirePlanSignoff: false,
      hasServiceContracts: true,
    }),
  ).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx bun test tests-ts/ssot/plan_auto_accept.test.ts`
Expected: FAIL —— 模块 `plan_auto_accept.js` 不存在 / `shouldAutoAcceptPlan` 未定义。

- [ ] **Step 3: 实现纯函数** `packages/ssot-ts/src/state_machine/plan_auto_accept.ts`

```ts
/**
 * simple 免签判据 (spec 2026-07-01)。
 *
 * plan_check 通过后由 Coordinator.submitPlan 调用: 返回 true → 自动接受计划进 IMPLEMENTING
 * (不设 plan_signoff); false → 退化为现有人工 plan_signoff 停人。
 *
 * 与 submitWrapUp 的条件锚点判据 (risk:high / exclusive 一票否决) 同构, 额外加复杂度闸
 * (仅 simple) + 契约闸 + opt-out 开关。IO (契约文件是否存在) 由调用侧探好传入, 本函数保持纯。
 */
import { RiskLevel } from "../schema/task_plan.js";
import type { Task } from "../schema/task_plan.js";
import type { Complexity } from "../schema/run_state.js";

/** shouldAutoAcceptPlan 入参。契约文件是否存在等 IO 由调用侧探好传入。 */
export interface AutoAcceptInput {
  complexity: Complexity;
  tasks: readonly Task[];
  requirePlanSignoff: boolean;
  hasServiceContracts: boolean;
}

/**
 * 免签判据: 全部条件同时满足才返回 true。
 * 任一不满足 → false (调用侧退化为人工 plan_signoff)。
 */
export function shouldAutoAcceptPlan(input: AutoAcceptInput): boolean {
  if (input.complexity !== "simple") return false; // 复杂度闸: 仅 simple
  if (input.requirePlanSignoff) return false; // opt-out 开关强制门禁
  if (input.hasServiceContracts) return false; // 风险闸③: 契约=跨服务
  if (input.tasks.some((t) => t.risk === RiskLevel.high)) return false; // 风险闸①
  if (input.tasks.some((t) => t.exclusive)) return false; // 风险闸②
  return true;
}
```

- [ ] **Step 4: 导出模块** —— `packages/ssot-ts/src/state_machine/index.ts` 追加一行:

```ts
export * from "./transitions.js";
export * from "./human_anchors.js";
export * from "./plan_auto_accept.js";
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx bun test tests-ts/ssot/plan_auto_accept.test.ts`
Expected: PASS(6 个用例全绿）。

- [ ] **Step 6: commit**

```bash
git add packages/ssot-ts/src/state_machine/plan_auto_accept.ts packages/ssot-ts/src/state_machine/index.ts tests-ts/ssot/plan_auto_accept.test.ts
git commit -m "feat(state_machine): 新增 shouldAutoAcceptPlan simple 免签判据

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `Coordinator.submitPlan` 免签分叉 + 诚实标记

**Files:**
- Modify: `packages/ssot-ts/src/runtime/coordinator.ts:331-334`(`submitPlan` 通过分支)+ 新增私有方法
- Test: `tests-ts/ssot/coordinator_plan_auto_accept.test.ts`

**Interfaces:**
- Consumes: `shouldAutoAcceptPlan`(Task 2)、`RunConfig.require_plan_signoff`(Task 1)、已存在的 `advancePhase` / `Phase` / `RiskLevel` / `nowUtc`。
- Produces: `submitPlan` 免签时写 `runs/<id>/planning/plan-auto-accepted.json` 并 advance 到 IMPLEMENTING。

- [ ] **Step 1: 写失败测试** `tests-ts/ssot/coordinator_plan_auto_accept.test.ts`

```ts
/**
 * Coordinator.submitPlan simple 免签分支 (spec 2026-07-01)。
 */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  Coordinator,
  initRunDir,
  writeRunState,
} from "../../packages/ssot-ts/src/runtime/index.js";
import { RecordingWorkerRunner } from "../../packages/ssot-ts/src/dispatch/index.js";
import { HumanPending, Phase, parseRunState } from "../../packages/ssot-ts/src/schema/run_state.js";
import { parseTaskPlan } from "../../packages/ssot-ts/src/schema/task_plan.js";
import type { TaskPlan } from "../../packages/ssot-ts/src/schema/task_plan.js";

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loop-autoaccept-"));
}

/** 干净 simple plan: 1 task, normal risk, 非 exclusive。 */
function cleanSimplePlan(opts?: { riskHigh?: boolean; exclusive?: boolean }): TaskPlan {
  return parseTaskPlan({
    complexity: "simple",
    tasks: [
      {
        id: "T01",
        title: "simple task",
        allowed_write_paths: ["src/**"],
        acceptance_refs: ["AC-001"],
        risk: opts?.riskHigh ? "high" : "normal",
        exclusive: opts?.exclusive ?? false,
        tests: [{ id: "t1", scenario: "happy", checks: ["passed == true"] }],
      },
    ],
  });
}

/** 建 run 目录 + 写 CREATED state, 返回 runDir。config 可注入 require_plan_signoff。 */
function setup(opts?: { complexity?: string; requireSignoff?: boolean }): string {
  const runsRoot = path.join(makeTmp(), "runs");
  const runId = "20260701-001";
  const runDir = initRunDir(runsRoot, runId, "auto-accept test");
  const stateInput: Record<string, unknown> = {
    run_id: runId,
    complexity: opts?.complexity ?? "simple",
    phase: Phase.CREATED,
  };
  if (opts?.requireSignoff) stateInput.config = { require_plan_signoff: true };
  // medium/complex 裁量跳过需留证, 免 plan_check 的 clarification_evidence 挡路。
  if ((opts?.complexity ?? "simple") !== "simple") {
    fs.writeFileSync(
      path.join(runDir, "clarification", "questions.json"),
      JSON.stringify({ questions: [], skip_basis: [{ considered: "x", why_non_blocking: "测试固定输入" }] }),
      "utf-8",
    );
  }
  writeRunState(runDir, parseRunState(stateInput));
  return runDir;
}

test("simple 干净 run → 免签: phase=IMPLEMENTING, human_pending 从不为 plan_signoff, 标记落盘", () => {
  const runDir = setup();
  const coord = new Coordinator(runDir, new RecordingWorkerRunner([]));
  coord.startPlanning();
  coord.submitPlan(cleanSimplePlan());

  expect(coord.state.phase).toBe(Phase.IMPLEMENTING);
  expect(coord.state.human_pending ?? null).toBeNull();
  expect(coord.state.human_pending).not.toBe(HumanPending.plan_signoff); // 防误标反向断言

  const markerPath = path.join(runDir, "planning", "plan-auto-accepted.json");
  expect(fs.existsSync(markerPath)).toBe(true);
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as Record<string, unknown>;
  expect(marker.auto_accepted).toBe(true);
  expect(typeof marker.accepted_at).toBe("string");
  // 措辞红线: 标记里不出现"签署/signed"字样
  expect(JSON.stringify(marker)).not.toContain("签署");
  expect(JSON.stringify(marker).toLowerCase()).not.toContain("signed");
});

test("simple + require_plan_signoff=true → 停 PLANNING + plan_signoff (opt-out 拉回门禁)", () => {
  const runDir = setup({ requireSignoff: true });
  const coord = new Coordinator(runDir, new RecordingWorkerRunner([]));
  coord.startPlanning();
  coord.submitPlan(cleanSimplePlan());

  expect(coord.state.phase).toBe(Phase.PLANNING);
  expect(coord.state.human_pending).toBe(HumanPending.plan_signoff);
  expect(fs.existsSync(path.join(runDir, "planning", "plan-auto-accepted.json"))).toBe(false);
});

test("simple + risk:high task → plan_signoff (风险闸生效)", () => {
  const runDir = setup();
  const coord = new Coordinator(runDir, new RecordingWorkerRunner([]));
  coord.startPlanning();
  coord.submitPlan(cleanSimplePlan({ riskHigh: true }));

  expect(coord.state.phase).toBe(Phase.PLANNING);
  expect(coord.state.human_pending).toBe(HumanPending.plan_signoff);
});

test("medium run → plan_signoff (非 simple 老路径零改变)", () => {
  const runDir = setup({ complexity: "medium" });
  const coord = new Coordinator(runDir, new RecordingWorkerRunner([]));
  coord.startPlanning();
  coord.submitPlan(parseTaskPlan({
    complexity: "medium",
    tasks: [
      { id: "T01", title: "t", allowed_write_paths: ["src/**"], acceptance_refs: ["AC-001"],
        tests: [{ id: "t1", scenario: "happy", checks: ["passed == true"] }] },
    ],
  }));

  expect(coord.state.phase).toBe(Phase.PLANNING);
  expect(coord.state.human_pending).toBe(HumanPending.plan_signoff);
});

test("simple 但 plan_check 失败 → 不免签、不设锚点、写 plan-check-failures.json", () => {
  const runDir = setup();
  const coord = new Coordinator(runDir, new RecordingWorkerRunner([]));
  coord.startPlanning();
  // 无 test 用例的 task → plan_check 的 AC↔测试覆盖失败。
  coord.submitPlan(parseTaskPlan({
    complexity: "simple",
    tasks: [
      { id: "T01", title: "t", allowed_write_paths: ["src/**"], acceptance_refs: ["AC-001"], tests: [] },
    ],
  }));

  expect(coord.state.phase).toBe(Phase.PLANNING);
  expect(coord.state.human_pending ?? null).toBeNull();
  expect(fs.existsSync(path.join(runDir, "planning", "plan-auto-accepted.json"))).toBe(false);
  expect(fs.existsSync(path.join(runDir, "planning", "plan-check-failures.json"))).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx bun test tests-ts/ssot/coordinator_plan_auto_accept.test.ts`
Expected: FAIL —— 首个用例期望 `IMPLEMENTING` 但当前 `submitPlan` 无条件设 `plan_signoff`(停 PLANNING）。

- [ ] **Step 3: 改 `submitPlan` 分支**

`packages/ssot-ts/src/runtime/coordinator.ts` 顶部 import 追加:

```ts
import { shouldAutoAcceptPlan } from "../state_machine/plan_auto_accept.js";
```

把 `submitPlan` 中"通过 → 写 plan + set human_pending"那段(约 `:331-334`)替换为:

```ts
    // 通过 → 写 plan。simple 且未触发风险闸/未强制门禁 → 免签自动进 IMPLEMENTING; 否则设 plan_signoff。
    this.refreshPlanFile();
    const hasContracts = fs.existsSync(
      path.join(this.runDir, "planning", "service-contracts.yaml"),
    );
    const autoAccept = shouldAutoAcceptPlan({
      complexity: this.state.complexity,
      tasks: plan.tasks,
      requirePlanSignoff: this.state.config.require_plan_signoff,
      hasServiceContracts: hasContracts,
    });
    if (autoAccept) {
      // 诚实记账: 免签 ≠ 已签, 写独立审计标记后直接 advance (不设 human_pending)。
      this.writePlanAutoAccepted(plan, hasContracts);
      this.state = advancePhase(this.state, Phase.IMPLEMENTING);
    } else {
      this.state = setHumanPending(this.state, HumanPending.plan_signoff);
    }
    this.refreshStateFile();
```

- [ ] **Step 4: 加私有方法 `writePlanAutoAccepted`**

在 `submitPlan` 之后(`signoffPlan` 之前)加:

```ts
  /**
   * 免签时写诚实审计标记 planning/plan-auto-accepted.json。
   *
   * 与 signoff-feedback.md (人工反馈) 分属不同文件/语义, 绝不复用; 措辞禁用"签署/signed"。
   * 后续任何人翻此 run, 一眼看出"计划从未经人工冻结意图, 是规则自动放行的"。
   */
  private writePlanAutoAccepted(plan: TaskPlan, hasContracts: boolean): void {
    const hasHigh = plan.tasks.some((t) => t.risk === RiskLevel.high);
    const hasExclusive = plan.tasks.some((t) => t.exclusive);
    const marker = {
      auto_accepted: true,
      accepted_at: nowUtc().toISOString(),
      reason:
        "complexity=simple 且未触发风险闸(无 risk:high / 无 exclusive / 无 service-contracts)",
      criteria_snapshot: {
        complexity: this.state.complexity,
        require_plan_signoff: this.state.config.require_plan_signoff,
        has_high_risk: hasHigh,
        has_exclusive: hasExclusive,
        has_contracts: hasContracts,
      },
    };
    const p = path.join(this.runDir, "planning", "plan-auto-accepted.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${JSON.stringify(marker, null, 2)}\n`, "utf-8");
  }
```

（`advancePhase` / `Phase` / `RiskLevel` / `nowUtc` / `fs` / `path` / `TaskPlan` 均已在 coordinator.ts import,无需新增,除 Step 3 的 `shouldAutoAcceptPlan`。）

- [ ] **Step 5: 跑测试确认通过**

Run: `npx bun test tests-ts/ssot/coordinator_plan_auto_accept.test.ts`
Expected: PASS(5 个用例全绿）。

- [ ] **Step 6: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无报错。

- [ ] **Step 7: commit**

```bash
git add packages/ssot-ts/src/runtime/coordinator.ts tests-ts/ssot/coordinator_plan_auto_accept.test.ts
git commit -m "feat(coordinator): submitPlan simple 免签分叉 + plan-auto-accepted.json 诚实记账

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: 现有 Coordinator 级回归测试修复(注入 opt-out 保原样)

**背景:** 现有测试大量用 `submitPlan(cleanSimple) → 断言 plan_signoff → signoffPlan(true)`。免签默认开后,干净 simple plan 直接进 IMPLEMENTING → 断言失败 + `signoffPlan` 因 `phase!==PLANNING` 抛错。这些测试的**目的是下游流程**(dispatch/collect/tick/wrap-up/e2e),非 plan 门禁本身。**最小改动的忠实修复 = 给其 run-state 注入 `config:{require_plan_signoff:true}`**,保持"人工门禁"流程不变。

**Files(逐一注入 `config:{require_plan_signoff:true}` 到 run-state 构造):**
- Modify: `tests-ts/ssot/coordinator_plan_restore.test.ts` — 行 140-142(e2e)、252-253(plan-amendment)、349-350(单写者持久化)对应的 `writeRunState(parseRunState({...}))`
- Modify: `tests-ts/ssot/coordinator_dispatch_collect.test.ts` — 行 192-193 / 324-325 / 683-684 对应的 run-state 构造(多半在共享 helper,改一处即可)
- Modify: `tests-ts/integration_dry_run.test.ts` — 行 137-139 / 201-202 / 261-262 对应的 Coordinator 级 run-state 构造

**说明:** `riskHigh`/`exclusive` 的现有用例(`coordinator_plan_restore.test.ts:278/305/327`、`integration_dry_run.test.ts:225`)天然被风险闸挡住 → 仍走 `plan_signoff`,**无需改**。

- [ ] **Step 1: 定位并注入(以 coordinator_plan_restore.test.ts 的 e2e 用例为范式)**

把:
```ts
writeRunState(runDir, parseRunState({ run_id: runId, complexity: "simple", phase: Phase.CREATED }));
```
改为:
```ts
writeRunState(runDir, parseRunState({
  run_id: runId, complexity: "simple", phase: Phase.CREATED,
  config: { require_plan_signoff: true },   // 保留人工 plan 门禁 (下游流程测试, 非免签测试)
}));
```
对**每一个**"随后会 `submitPlan(cleanSimple)` 且 `signoffPlan(true)`"的用例的 run-state 构造施加同样注入。共享 helper(如 `coordinator_dispatch_collect.test.ts` 里构造 Coordinator 的 helper)只需改 helper 内那一处。

- [ ] **Step 2: 逐文件跑,确认恢复绿**

```bash
npx bun test tests-ts/ssot/coordinator_plan_restore.test.ts
npx bun test tests-ts/ssot/coordinator_dispatch_collect.test.ts
npx bun test tests-ts/integration_dry_run.test.ts
```
Expected: 三个文件全绿(若仍有红,按报错定位遗漏的 run-state 构造点补注入;CLI 级用例留到 Task 5)。

> 注意:`integration_dry_run.test.ts` 里若有**经 CLI(`runPlan`/`init`)**驱动的用例(如行 359-365),它们经 `init` 默认配置,**不适用**本任务的注入法(CLI 无该字段入口)→ 归 Task 5 处理。本任务只改直接 `new Coordinator` + `coord.submitPlan/signoffPlan` 的用例。

- [ ] **Step 3: commit**

```bash
git add tests-ts/ssot/coordinator_plan_restore.test.ts tests-ts/ssot/coordinator_dispatch_collect.test.ts tests-ts/integration_dry_run.test.ts
git commit -m "test: 现有下游测试注入 require_plan_signoff 保留人工门禁, 适配 simple 免签默认

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: CLI —— `init` 加 opt-out flag + `plan` 免签说明 + CLI 测试适配

**Files:**
- Modify: `packages/cli/src/args.ts`(注册 `--require-plan-signoff` flag)
- Modify: `packages/cli/src/commands/dryrun.ts`(`runInit` 写 config + `runPlan` 免签说明行)
- Modify: `tests-ts/integration_dry_run.test.ts`(CLI 级用例)、`tests-ts/integration_dispatch_collect.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `require_plan_signoff` config、Task 3 的 `submitPlan` 免签行为。
- Produces: `e2e-loop init ... --require-plan-signoff` 写 `config.require_plan_signoff=true`;`e2e-loop plan` 免签时 stdout 含 `auto-accepted`。

- [ ] **Step 1: 先看 args.ts 现有 flag 注册法**

Run: `cat packages/cli/src/args.ts`(或 Read 工具)。确认布尔 flag 如何注册(是否 `flags` Set 还是 `values`)。按同款加 `require-plan-signoff`。

- [ ] **Step 2: `runInit` 写 config(dryrun.ts:358-370 附近)**

在构造 `stateInput` 处,读 flag 并注入 config:
```ts
  const stateInput: Record<string, unknown> = {
    run_id: runId,
    complexity,
    phase: Phase.CREATED,
  };
  if (args.flags.has("require-plan-signoff")) {
    stateInput.config = { require_plan_signoff: true };
  }
```
（`args.flags` 是否为 Set 视 Step 1 结论;若 flag 走 `args.values` 则用对应判断。）

- [ ] **Step 3: `runPlan` 加免签说明行(dryrun.ts:495-499)**

替换 stdout 段:
```ts
  coord.submitPlan(plan);
  const autoAccepted = fs.existsSync(
    path.join(runDir, "planning", "plan-auto-accepted.json"),
  );
  process.stdout.write(
    `run ${runId}: PLANNING 提交完成, phase=${coord.state.phase}, ` +
      `human_pending=${humanPendingText(coord.state.human_pending)}` +
      (autoAccepted ? " (auto-accepted: simple 免签, 无人工签署)" : "") +
      `\n`,
  );
```

- [ ] **Step 4: 写/改 CLI 测试**

在 `tests-ts/integration_dry_run.test.ts` 的 CLI 段(行 340-370 附近),把断言 `plan_signoff` 的**干净 simple** CLI 用例改为断言免签:
```ts
// 免签: plan 命令后直接 IMPLEMENTING, stdout 含 auto-accepted, 无 plan_signoff
expect(planOut).toContain("phase=IMPLEMENTING");
expect(planOut).toContain("auto-accepted");
expect(readRunState(runDir).human_pending ?? null).toBeNull();
```
并**新增**一个 CLI 用例覆盖 opt-out:`init ... --require-plan-signoff` → `plan` → 断言 `human_pending=plan_signoff`、`phase=PLANNING`。
`tests-ts/integration_dispatch_collect.test.ts`:若它经 CLI `init`(默认配置)+ 干净 simple plan 到达 IMPLEMENTING,则删除现在多余的 `signoff-plan` 步骤(免签后 `plan` 命令已使其 IMPLEMENTING);跑测定位具体行。

- [ ] **Step 5: 跑 CLI 测试**

```bash
npx bun test tests-ts/integration_dry_run.test.ts
npx bun test tests-ts/integration_dispatch_collect.test.ts
```
Expected: 全绿。

- [ ] **Step 6: commit**

```bash
git add packages/cli/src/args.ts packages/cli/src/commands/dryrun.ts tests-ts/integration_dry_run.test.ts tests-ts/integration_dispatch_collect.test.ts
git commit -m "feat(cli): init 加 --require-plan-signoff, plan 命令标注 auto-accepted, 测试适配

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: guard_anchors Stop hook 回归(免签后不早停)

**Files:**
- Modify: `tests-ts/guard_anchors.test.ts`

**说明:** 免签后 `phase=IMPLEMENTING` 且无 `human_pending`,有 pending task。`checkImplementingPhase` 应 deny 并催"继续 tick 派发"([guard_anchors/logic.ts:208](packages/shared/src/hooks/guard_anchors/logic.ts:208))。`guard_anchors` 逻辑无需改,只补一条固化用例。

- [ ] **Step 1: 看现有 guard_anchors 测试的 fixture 搭建法**

Run: `cat tests-ts/guard_anchors.test.ts`。找到构造 run-state + task-plan(有 pending task)+ 调 hook `handle` 的既有范式(参考现有 IMPLEMENTING pending 用例,即测 §8b)。

- [ ] **Step 2: 加用例(套用现有 fixture 范式,断言 deny + 催继续)**

```ts
test("[新增] simple 免签后 IMPLEMENTING + 有 pending task + 无 human_pending → deny 催继续", async () => {
  // 构造: phase=IMPLEMENTING, human_pending=null, task-plan 含 1 个 pending task。
  // (复用本文件既有的 run 目录/写 state/写 plan helper)
  const out = await handle(/* input 指向该 runDir 的 cwd */);
  expect(out.decision).toBe("deny");
  expect(out.reason).toContain("pending");
  expect(out.reason).toContain("结束回合");
});
```
（具体 `handle` 入参与 helper 名以文件现有用例为准,照抄其构造方式,仅把 `human_pending` 置空、task 置 `pending`。）

- [ ] **Step 3: 跑测试**

Run: `npx bun test tests-ts/guard_anchors.test.ts`
Expected: PASS。

- [ ] **Step 4: commit**

```bash
git add tests-ts/guard_anchors.test.ts
git commit -m "test(guard_anchors): 固化 simple 免签后 IMPLEMENTING pending 不早停

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: SKILL 提示词 `core/coordinator.md` 更新

**Files:**
- Modify: `core/coordinator.md`(§2 阶段 2、§2 核心信条 3、§7 表、§末尾硬不变量)

**说明:** 真实 run 的协调器是主 agent,SKILL 必须同步,否则 TS 改了、提示词没改,主 agent 仍停人拍板。纯文本改动,无自动化测试;靠人复核 + 后续真实 run 验证。

- [ ] **Step 1: §2 阶段 2「→ 计划拍板(人盯点 1)」加免签分叉**

在该段落(coordinator.md:188 附近)前面补一段:
> **simple 免签(条件跳过拍板):** 若 `complexity=simple` 且未触发风险闸(无 task `risk:high`、无 `exclusive`、无 `service-contracts.yaml`)、且 `run-state.config.require_plan_signoff` 非 true → **免签**:把计划摘要呈给人 + 明确声明"**已自动接受**(无人工签署)" + Coordinator 写 `planning/plan-auto-accepted.json` + 直接进 IMPLEMENTING + **不停回合**(继续 tick 派发)。措辞禁用"签署/已拍板"。人若要改,回滚 `IMPLEMENTING → PLANNING`(plan-amendment 快路径)。否则(medium/complex 或命中风险闸或 config 强制)→ 设 `plan_signoff` 停人(下述现有行为)。

- [ ] **Step 2: §2 核心信条第 3 条加限定注脚**

在"质量的最终锚点是人在计划拍板时冻结意图"后补:
> (simple 低风险单一改动按规则免签、诚实记账;意图冻结锚点对 medium/complex 及命中风险闸的 run 保留。)

- [ ] **Step 3: §7 注意力预算表**

把"计划拍板 —— 验收语义是否正确"一栏标注为**条件人盯**:
> 计划拍板 —— 验收语义是否正确(**medium/complex 及风险 run**;simple 低风险按规则免签、诚实记账)

- [ ] **Step 4: §末尾"停回合的唯一依据(硬不变量)"补一句**

在列举合法停回合依据处补:
> (simple 免签**不是**停回合点:它不设 `human_pending`,advance 到 IMPLEMENTING 后继续 tick 派发。)

- [ ] **Step 5: commit**

```bash
git add core/coordinator.md
git commit -m "docs(skill): coordinator.md 加 simple 免签分叉与条件人盯说明

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: 规范源文档 + changelog

**Files:**
- Modify: `docs/loop-engineering-collaborative-design.md`(§1/§7 方法论演进注)
- Modify: `docs/loop-engineering-master-prompt.md` / `docs/loop-engineering-prompts.md`(若引用"plan 必经拍板"则加同款注)
- Modify: `changlog.md`

- [ ] **Step 1: design 文档加方法论演进注**

在 `docs/loop-engineering-collaborative-design.md` §1 与 §7 相关处,比照文件内 2026-06-28 演进注的写法,加:
> 方法论演进 (2026-07-01): `plan_signoff` 对 `complexity=simple` 且未触发风险闸(risk:high/exclusive/契约)、未强制 `require_plan_signoff` 的 run 降级为条件锚点——`plan_check` 通过后自动接受进 IMPLEMENTING,写 `planning/plan-auto-accepted.json` 诚实记账(绝不记为人工签署)。medium/complex 及命中风险闸的 run 保留必经拍板。与 wrap_up_signoff 的条件锚点演进同构。

- [ ] **Step 2: master-prompt / prompts 一致性**

Run: `grep -n "plan.*拍板\|plan_signoff\|计划拍板" docs/loop-engineering-master-prompt.md docs/loop-engineering-prompts.md`
对出现"必经/无条件计划拍板"处加同款限定注脚(simple 免签例外)。若无相关表述,跳过。

- [ ] **Step 3: changelog**

Run: `cat changlog.md`(看最新版本号/格式）。在对应(未发布/当前)版本下加:
```markdown
### 新增
- plan 拍板条件锚点化: simple 且未触发风险闸的 run 免签自动进 IMPLEMENTING;新增 RunConfig.require_plan_signoff 开关(默认 false,可 opt-out 回门禁)与 planning/plan-auto-accepted.json 诚实审计标记。CLI init 加 --require-plan-signoff。
```

- [ ] **Step 4: commit**

```bash
git add docs/loop-engineering-collaborative-design.md docs/loop-engineering-master-prompt.md docs/loop-engineering-prompts.md changlog.md
git commit -m "docs: 记录 plan 拍板条件锚点化 (simple 免签) 方法论演进与 changelog

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: 全量验证 + 构建

**Files:** 无新增(纯验证)。

- [ ] **Step 1: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无报错。

- [ ] **Step 2: 全量测试**

Run: `npx bun test tests-ts/`
Expected: 全绿。若有红,定位是否遗漏的 `submitPlan(cleanSimple)+signoffPlan` 站点(回 Task 4/5 补注入/改断言)。

- [ ] **Step 3: 构建(确认 hooks/plugin/cli bundle 不炸)**

Run: `npm run build`
Expected: 成功产出。

- [ ] **Step 4: (可选) 端到端 dry-run 手验免签**

```bash
node packages/cli/dist/index.js init tests-ts/fixtures/smoke/requirement.md --worktree-mode none --runs-root /tmp/le-verify/runs
# 记下 run_id, 用 smoke 的 design/task-plan 跑 plan, 观察 stdout 是否含 auto-accepted + phase=IMPLEMENTING
```
Expected: 干净 simple run 打印 `phase=IMPLEMENTING ... (auto-accepted...)`,无 `plan_signoff`。

- [ ] **Step 5: 若 Step 3 产出有变更需提交则 commit;否则跳过**

```bash
git add -A && git commit -m "chore: 构建产物同步 (simple 免签)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review(计划自审)

**1. Spec 覆盖:**
- 判据规则 §1 → Task 2(纯函数)+ Task 3(接入)。✅
- 落地点 §2(a/b/c)→ Task 2 / Task 1 / Task 3。✅
- 诚实记账 §3(a 标记文件 / b 呈现回滚 / c 措辞)→ Task 3(标记+措辞断言)/ Task 7(SKILL 呈现与回滚话术)。✅
- SKILL+hook §4 → Task 7(SKILL)+ Task 6(guard_anchors 回归,确认无需改逻辑)+ Task 8(docs/changelog)。✅
- 测试 §5(a/b/c)→ Task 2 / Task 3 / Task 1+Task 6。✅
- 跨宿主说明 → 无 binding 改动,Task 9 全量测试覆盖。✅

**2. 占位符扫描:** 无 TBD/TODO。Task 5 Step 1、Task 6 Step 1 要求先读现有文件确认 flag/fixture 范式——这是"照现有惯例施加已明确的改动",非占位(改动内容与断言已给全)。

**3. 类型一致性:** `shouldAutoAcceptPlan(AutoAcceptInput)` 签名在 Task 2 定义、Task 3 调用一致;`require_plan_signoff` 在 Task 1 定义、Task 3/Task 5 消费一致;标记文件名 `plan-auto-accepted.json` 全计划一致;`RiskLevel.high` / `Phase.IMPLEMENTING` 用现有导出。

**回归面已显式建任务(Task 4/5)** —— 这是本计划最大的风险点,已按 grep 出的精确站点逐一列出并给修复范式。
