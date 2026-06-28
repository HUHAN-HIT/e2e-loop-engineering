/**
 * key-diffs 硬 gate 等价测试 (P4-M4, design §2.3)。
 *
 * 行为权威: Python `tests/test_key_diffs_gate.py` + `loop_engineering/checklists/key_diffs_gate.py`。
 * 被测实现: `packages/ssot-ts/src/checklists/key_diffs_gate.ts`。
 *
 * 覆盖: isHardGateTask (high/exclusive/both/normal)、validateKeyDiffsSubmission
 * (硬 gate pass/missing/empty/raw_text 富化; 普通 task pass/soft)、validateMany (mixed/order/
 * all_must_pass/soft 不阻断)、allHardGatesPass。
 */
import { test, expect, describe } from "bun:test";

import {
  GateStatus,
  allHardGatesPass,
  isHardGateTask,
  validateKeyDiffsSubmission,
  validateMany,
} from "../../packages/ssot-ts/src/checklists/key_diffs_gate.js";
import { KeyDiffsFileSchema } from "../../packages/ssot-ts/src/schema/artifacts.js";
import type { KeyDiffsFile } from "../../packages/ssot-ts/src/schema/artifacts.js";
import { RiskLevel, TaskSchema } from "../../packages/ssot-ts/src/schema/task_plan.js";
import type { Task } from "../../packages/ssot-ts/src/schema/task_plan.js";

function makeTask(
  taskId = "t1",
  opts?: { risk?: RiskLevel; exclusive?: boolean },
): Task {
  return TaskSchema.parse({
    id: taskId,
    title: `title for ${taskId}`,
    allowed_write_paths: ["src/"],
    acceptance_refs: ["AC-1"],
    risk: opts?.risk ?? RiskLevel.normal,
    exclusive: opts?.exclusive ?? false,
  });
}

function makeKeyDiffs(taskId = "t1", n = 1): KeyDiffsFile {
  return KeyDiffsFileSchema.parse({
    task_id: taskId,
    key_diffs: Array.from({ length: n }, (_, i) => ({
      file: `src/file${i}.py`,
      change: `change ${i}`,
      why: `why ${i}`,
      risk: `risk ${i}`,
    })),
  });
}

// ---------------------------------------------------------------------------
// isHardGateTask
// ---------------------------------------------------------------------------

describe("TestIsHardGate", () => {
  test("[py: test_is_hard_gate_high_risk]", () => {
    expect(isHardGateTask(makeTask("t1", { risk: RiskLevel.high }))).toBe(true);
  });

  test("[py: test_is_hard_gate_exclusive]", () => {
    expect(isHardGateTask(makeTask("t1", { exclusive: true }))).toBe(true);
  });

  test("[py: test_is_hard_gate_high_risk_and_exclusive]", () => {
    expect(
      isHardGateTask(makeTask("t1", { risk: RiskLevel.high, exclusive: true })),
    ).toBe(true);
  });

  test("[py: test_is_hard_gate_normal]", () => {
    expect(
      isHardGateTask(makeTask("t1", { risk: RiskLevel.normal, exclusive: false })),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateKeyDiffsSubmission
// ---------------------------------------------------------------------------

describe("TestValidateSubmission", () => {
  test("[py: test_validate_hard_gate_pass]", () => {
    const t = makeTask("t1", { risk: RiskLevel.high });
    const r = validateKeyDiffsSubmission(t, makeKeyDiffs("t1", 2));
    expect(r.status).toBe(GateStatus.PASS);
    expect(r.task_id).toBe("t1");
    expect(r.reason).toContain("2 条");
  });

  test("[py: test_validate_hard_gate_pass_exclusive]", () => {
    const t = makeTask("t1", { exclusive: true });
    const r = validateKeyDiffsSubmission(t, makeKeyDiffs());
    expect(r.status).toBe(GateStatus.PASS);
  });

  test("[py: test_validate_hard_gate_missing_file]", () => {
    const t = makeTask("t1", { risk: RiskLevel.high });
    const r = validateKeyDiffsSubmission(t, null);
    expect(r.status).toBe(GateStatus.FAIL);
    expect(r.reason.includes("硬 gate") || r.reason.includes("缺")).toBe(true);
  });

  test("[py: test_validate_hard_gate_missing_file_with_raw_text]", () => {
    const t = makeTask("t1", { risk: RiskLevel.high });
    const r = validateKeyDiffsSubmission(t, null, {
      rawYamlText: "corrupted: [unterminated",
    });
    expect(r.status).toBe(GateStatus.FAIL);
    // 诊断富化: 包含原始片段
    expect(r.reason.includes("corrupted") || r.reason.includes("raw_yaml_text")).toBe(
      true,
    );
  });

  test("[py: test_validate_hard_gate_empty_diffs]", () => {
    const t = makeTask("t1", { risk: RiskLevel.high });
    const r = validateKeyDiffsSubmission(t, makeKeyDiffs("t1", 0));
    expect(r.status).toBe(GateStatus.FAIL);
    expect(r.reason).toContain("空");
  });

  test("[py: test_validate_normal_task_pass_with_diffs]", () => {
    const t = makeTask(); // normal, non-exclusive
    const r = validateKeyDiffsSubmission(t, makeKeyDiffs());
    expect(r.status).toBe(GateStatus.PASS);
  });

  test("[py: test_validate_normal_task_soft_without_diffs]", () => {
    const t = makeTask();
    const r = validateKeyDiffsSubmission(t, null);
    expect(r.status).toBe(GateStatus.SOFT);
    expect(r.reason).toContain("软约束");
  });

  test("[py: test_validate_normal_task_soft_with_empty_diffs]", () => {
    const t = makeTask();
    const r = validateKeyDiffsSubmission(t, makeKeyDiffs("t1", 0));
    expect(r.status).toBe(GateStatus.SOFT);
  });
});

// ---------------------------------------------------------------------------
// validateMany
// ---------------------------------------------------------------------------

describe("TestValidateMany", () => {
  test("[py: test_validate_many_mixed]", () => {
    const tasks = [
      makeTask("t-high", { risk: RiskLevel.high }),
      makeTask("t-excl", { exclusive: true }),
      makeTask("t-normal"),
    ];
    const kd: Record<string, KeyDiffsFile | null> = {
      "t-high": makeKeyDiffs("t-high"),
      "t-excl": null, // FAIL
      "t-normal": null, // SOFT
    };
    const results = validateMany(tasks, kd);
    expect(results.length).toBe(3);
    const byId = new Map(results.map((r) => [r.task_id, r]));
    expect(byId.get("t-high")!.status).toBe(GateStatus.PASS);
    expect(byId.get("t-excl")!.status).toBe(GateStatus.FAIL);
    expect(byId.get("t-normal")!.status).toBe(GateStatus.SOFT);
  });

  test("[py: test_validate_many_returns_in_order]", () => {
    const tasks = [makeTask("t1"), makeTask("t2"), makeTask("t3")];
    const kd: Record<string, KeyDiffsFile | null> = { t1: null, t2: null, t3: null };
    const results = validateMany(tasks, kd);
    expect(results.map((r) => r.task_id)).toEqual(["t1", "t2", "t3"]);
  });

  test("[py: test_validate_many_all_must_pass_for_complete]", () => {
    // 全过
    const tasksOk = [makeTask("t-high", { risk: RiskLevel.high })];
    const kdOk: Record<string, KeyDiffsFile | null> = { "t-high": makeKeyDiffs("t-high") };
    expect(allHardGatesPass(validateMany(tasksOk, kdOk))).toBe(true);

    // 任一 FAIL
    const tasksFail = [
      makeTask("t-high-1", { risk: RiskLevel.high }),
      makeTask("t-high-2", { risk: RiskLevel.high }),
    ];
    const kdFail: Record<string, KeyDiffsFile | null> = {
      "t-high-1": makeKeyDiffs("t-high-1"),
      "t-high-2": null, // FAIL
    };
    expect(allHardGatesPass(validateMany(tasksFail, kdFail))).toBe(false);
  });

  test("[py: test_validate_many_soft_does_not_block]", () => {
    const tasks = [makeTask("t-normal")];
    const kd: Record<string, KeyDiffsFile | null> = { "t-normal": null };
    const results = validateMany(tasks, kd);
    expect(results[0]!.status).toBe(GateStatus.SOFT);
    expect(allHardGatesPass(results)).toBe(true);
  });
});
