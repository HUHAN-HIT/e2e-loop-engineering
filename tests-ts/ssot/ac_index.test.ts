/**
 * ac_index 等价测试 (P4-M5)。
 *
 * 行为权威: Python `tests/test_ac_index.py` + `loop_engineering/amendment/ac_index.py`。
 * 被测实现: `packages/ssot-ts/src/amendment/ac_index.ts`。
 *
 * 覆盖: AC↔task 双向索引构建、无 AC task、排序稳定性、查表 helper 缺失返回空、同 task 内 AC 去重。
 */
import { test, expect } from "bun:test";

import {
  acsForTask,
  buildAcToTasks,
  buildTaskToAcs,
  tasksForAc,
} from "../../packages/ssot-ts/src/amendment/ac_index.js";
import type { Task, TaskPlan } from "@e2e-loop/ssot";
import { TaskSchema, TaskPlanSchema } from "@e2e-loop/ssot";

/** 构造最小 TaskPlan (complexity 随意, 不参与索引)。 */
function mkPlan(...tasks: Task[]): TaskPlan {
  return TaskPlanSchema.parse({ complexity: "simple", tasks });
}

function mkTask(tid: string, acs: string[]): Task {
  return TaskSchema.parse({
    id: tid,
    title: `task ${tid}`,
    allowed_write_paths: [`src/${tid}/**`],
    acceptance_refs: [...acs],
  });
}

test("[py: test_build_ac_to_tasks_basic] T01[AC-001,AC-002] + T02[AC-002,AC-003] → 多对多映射", () => {
  const plan = mkPlan(
    mkTask("T01", ["AC-001", "AC-002"]),
    mkTask("T02", ["AC-002", "AC-003"]),
  );
  const idx = buildAcToTasks(plan);
  expect(idx).toEqual({
    "AC-001": ["T01"],
    "AC-002": ["T01", "T02"],
    "AC-003": ["T02"],
  });
});

test("[py: test_build_task_to_acs_basic] 反向索引: task → ACs, 保序", () => {
  const plan = mkPlan(
    mkTask("T01", ["AC-001", "AC-002"]),
    mkTask("T02", ["AC-002", "AC-003"]),
  );
  const idx = buildTaskToAcs(plan);
  expect(idx).toEqual({
    T01: ["AC-001", "AC-002"],
    T02: ["AC-002", "AC-003"],
  });
});

test("[py: test_index_for_plan_with_no_ac_refs] 无 AC 的 task 不进 ac_index; task_index 以空列表出现", () => {
  const plan = mkPlan(mkTask("T01", []), mkTask("T02", ["AC-001"]));
  const acIdx = buildAcToTasks(plan);
  const taskIdx = buildTaskToAcs(plan);
  // T01 不在任何 AC value 中
  expect(Object.values(acIdx).every((v) => !v.includes("T01"))).toBe(true);
  expect(acIdx).toEqual({ "AC-001": ["T02"] });
  // T01 仍以空列表出现
  expect(taskIdx).toEqual({ T01: [], T02: ["AC-001"] });
});

test("[py: test_index_ordering_stable] 多 task 共享 AC 时按 task.id 字典序", () => {
  // 故意以非字典序插入
  const plan = mkPlan(
    mkTask("TZ", ["AC-001"]),
    mkTask("TA", ["AC-001"]),
    mkTask("TM", ["AC-001"]),
  );
  const idx = buildAcToTasks(plan);
  expect(idx["AC-001"]).toEqual(["TA", "TM", "TZ"]);
});

test("[py: test_tasks_for_ac_missing_returns_empty] 缺失 AC 返回空列表 (不报错)", () => {
  const idx = { "AC-001": ["T01"] };
  expect(tasksForAc(idx, "AC-001")).toEqual(["T01"]);
  expect(tasksForAc(idx, "AC-999")).toEqual([]);
});

test("[py: test_acs_for_task_missing_returns_empty] 缺失 task 返回空列表", () => {
  const idx = { T01: ["AC-001"] };
  expect(acsForTask(idx, "T01")).toEqual(["AC-001"]);
  expect(acsForTask(idx, "T999")).toEqual([]);
});

test("[py: test_index_handles_duplicate_ac_in_single_task] 同 task 同 AC 重复 → 去重", () => {
  const plan = mkPlan(mkTask("T01", ["AC-001", "AC-001", "AC-002"]));
  const acIdx = buildAcToTasks(plan);
  const taskIdx = buildTaskToAcs(plan);
  // AC → task 去重
  expect(acIdx).toEqual({ "AC-001": ["T01"], "AC-002": ["T01"] });
  // task → AC 去重保序
  expect(taskIdx).toEqual({ T01: ["AC-001", "AC-002"] });
});
