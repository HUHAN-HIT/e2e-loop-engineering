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
