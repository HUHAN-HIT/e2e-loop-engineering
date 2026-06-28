/**
 * rollback 等价测试 (P4-M5)。
 *
 * 行为权威: Python `tests/test_rollback.py` + `loop_engineering/amendment/rollback.py`。
 * 被测实现: `packages/ssot-ts/src/amendment/rollback.ts`。
 *
 * 覆盖: 基本回滚 (complete/running/pending/blocked/不相交)、保守扩围 (邻居 AC 传播)、
 * apply 不可变语义 (attempt 保留、untouched 全字段保留)、changes_semantics 透传、
 * 端到端 4-task 场景、summarize 空列表稳健。
 */
import { test, expect } from "bun:test";

import {
  applyRollback,
  computeRollback,
  expandAcceptanceRefs,
  summarize,
} from "../../packages/ssot-ts/src/amendment/rollback.js";
import type { RollbackPlan } from "../../packages/ssot-ts/src/amendment/rollback.js";
import {
  buildAcToTasks,
  buildTaskToAcs,
} from "../../packages/ssot-ts/src/amendment/ac_index.js";
import type { PlanAmendmentNeeded, Task, TaskPlan, TaskStatus } from "@e2e-loop/ssot";
import {
  PlanAmendmentNeededSchema,
  TaskSchema,
  TaskPlanSchema,
  TaskStatus as TaskStatusEnum,
} from "@e2e-loop/ssot";

// ---------- helpers ----------

function mkTask(
  tid: string,
  acs: string[],
  opts: { status?: TaskStatus; attempt?: number } = {},
): Task {
  return TaskSchema.parse({
    id: tid,
    title: `task ${tid}`,
    allowed_write_paths: [`src/${tid}/**`],
    acceptance_refs: [...acs],
    status: opts.status ?? TaskStatusEnum.pending,
    attempt: opts.attempt ?? 0,
  });
}

function mkPlan(...tasks: Task[]): TaskPlan {
  return TaskPlanSchema.parse({ complexity: "medium", tasks });
}

function mkAmendment(...acs: string[]): PlanAmendmentNeeded {
  return PlanAmendmentNeededSchema.parse({
    reason: "用例不可执行",
    touched_acceptance_refs: [...acs],
  });
}

// ---------- 基本回滚 ----------

test("[py: test_complete_task_intersecting_downgraded] complete + 相交 → downgrade", () => {
  const plan = mkPlan(mkTask("T01", ["AC-001"], { status: TaskStatusEnum.complete }));
  const rb = computeRollback(plan, mkAmendment("AC-001"));
  expect(rb.downgrade_to_pending).toEqual(["T01"]);
  expect(rb.recall_to_pending).toEqual([]);
  expect(rb.untouched).toEqual([]);
});

test("[py: test_running_task_intersecting_recalled] running + 相交 → recall", () => {
  const plan = mkPlan(mkTask("T02", ["AC-001"], { status: TaskStatusEnum.running }));
  const rb = computeRollback(plan, mkAmendment("AC-001"));
  expect(rb.recall_to_pending).toEqual(["T02"]);
  expect(rb.downgrade_to_pending).toEqual([]);
  expect(rb.untouched).toEqual([]);
});

test("[py: test_pending_task_intersecting_untouched] pending + 相交 → untouched", () => {
  const plan = mkPlan(mkTask("T03", ["AC-001"], { status: TaskStatusEnum.pending }));
  const rb = computeRollback(plan, mkAmendment("AC-001"));
  expect(rb.untouched).toEqual(["T03"]);
  expect(rb.downgrade_to_pending).toEqual([]);
  expect(rb.recall_to_pending).toEqual([]);
});

test("[py: test_blocked_task_intersecting_untouched] blocked + 相交 → untouched", () => {
  const plan = mkPlan(mkTask("T04", ["AC-001"], { status: TaskStatusEnum.blocked }));
  const rb = computeRollback(plan, mkAmendment("AC-001"));
  expect(rb.untouched).toEqual(["T04"]);
  expect(rb.downgrade_to_pending).toEqual([]);
  expect(rb.recall_to_pending).toEqual([]);
});

test("[py: test_non_intersecting_task_untouched] 不相交 task → untouched (无论状态)", () => {
  const plan = mkPlan(
    mkTask("T05a", ["AC-999"], { status: TaskStatusEnum.complete }),
    mkTask("T05b", ["AC-999"], { status: TaskStatusEnum.running }),
    mkTask("T05c", [], { status: TaskStatusEnum.complete }), // 无 AC 锚点, 必不相交
  );
  const rb = computeRollback(plan, mkAmendment("AC-001"));
  expect(new Set(rb.untouched)).toEqual(new Set(["T05a", "T05b", "T05c"]));
  expect(rb.downgrade_to_pending).toEqual([]);
  expect(rb.recall_to_pending).toEqual([]);
});

// ---------- 保守扩围 ----------

test("[py: test_expansion_to_neighbor_acs_in_same_task] 同 task 邻居 AC 扩围, T01 仍被 downgrade", () => {
  const plan = mkPlan(
    mkTask("T01", ["AC-001", "AC-002"], { status: TaskStatusEnum.complete }),
  );
  const rb = computeRollback(plan, mkAmendment("AC-001"));
  expect(new Set(rb.expanded_acceptance_refs)).toEqual(new Set(["AC-001", "AC-002"]));
  expect(new Set(rb.touched_acceptance_refs)).toEqual(new Set(["AC-001"]));
  expect(rb.downgrade_to_pending).toEqual(["T01"]);
});

test("[py: test_expansion_propagates_to_other_task_via_neighbor_ac] 邻居 AC 把另一 task 也纳入", () => {
  const plan = mkPlan(
    mkTask("T01", ["AC-001", "AC-002"], { status: TaskStatusEnum.complete }),
    mkTask("T02", ["AC-002"], { status: TaskStatusEnum.complete }),
  );
  const acIdx = buildAcToTasks(plan);
  const taskIdx = buildTaskToAcs(plan);
  const expanded = expandAcceptanceRefs(plan, acIdx, taskIdx, ["AC-001"]);
  expect(new Set(expanded)).toEqual(new Set(["AC-001", "AC-002"]));
  // 端到端: 两个 task 都应被 downgrade
  const rb = computeRollback(plan, mkAmendment("AC-001"));
  expect(new Set(rb.downgrade_to_pending)).toEqual(new Set(["T01", "T02"]));
});

test("[py: test_expansion_does_not_cross_unrelated_tasks] 扩围不跨无关 task", () => {
  const plan = mkPlan(
    mkTask("T01", ["AC-001"], { status: TaskStatusEnum.complete }),
    mkTask("T02", ["AC-999"], { status: TaskStatusEnum.complete }),
  );
  const acIdx = buildAcToTasks(plan);
  const taskIdx = buildTaskToAcs(plan);
  const expanded = expandAcceptanceRefs(plan, acIdx, taskIdx, ["AC-001"]);
  expect(new Set(expanded)).toEqual(new Set(["AC-001"]));
  const rb = computeRollback(plan, mkAmendment("AC-001"));
  expect(rb.downgrade_to_pending).toEqual(["T01"]);
  expect(rb.untouched).toContain("T02");
});

// ---------- apply 语义 ----------

test("[py: test_apply_returns_new_instance] apply 不改原 plan", () => {
  const plan = mkPlan(mkTask("T01", ["AC-001"], { status: TaskStatusEnum.complete }));
  const rb = computeRollback(plan, mkAmendment("AC-001"));
  const newPlan = applyRollback(plan, rb);
  expect(newPlan).not.toBe(plan);
  // 原 plan 中 T01 仍是 complete
  expect(plan.tasks[0].status).toBe(TaskStatusEnum.complete);
  // 新 plan 中 T01 已是 pending
  expect(newPlan.tasks[0].status).toBe(TaskStatusEnum.pending);
});

test("[py: test_apply_downgrade_keeps_attempt] downgrade 不重置 attempt", () => {
  const plan = mkPlan(
    mkTask("T01", ["AC-001"], { status: TaskStatusEnum.complete, attempt: 3 }),
  );
  const rb = computeRollback(plan, mkAmendment("AC-001"));
  const newPlan = applyRollback(plan, rb);
  expect(newPlan.tasks[0].status).toBe(TaskStatusEnum.pending);
  expect(newPlan.tasks[0].attempt).toBe(3); // 保留
});

test("[py: test_apply_recall_keeps_attempt] recall 不重置 attempt", () => {
  const plan = mkPlan(
    mkTask("T02", ["AC-001"], { status: TaskStatusEnum.running, attempt: 2 }),
  );
  const rb = computeRollback(plan, mkAmendment("AC-001"));
  const newPlan = applyRollback(plan, rb);
  expect(newPlan.tasks[0].status).toBe(TaskStatusEnum.pending);
  expect(newPlan.tasks[0].attempt).toBe(2);
});

test("[py: test_apply_untouched_preserved] untouched task 全字段原样保留", () => {
  const plan = mkPlan(
    mkTask("T01", ["AC-999"], { status: TaskStatusEnum.complete, attempt: 5 }),
    mkTask("T02", ["AC-001"], { status: TaskStatusEnum.complete, attempt: 1 }),
  );
  const rb = computeRollback(plan, mkAmendment("AC-001"));
  const newPlan = applyRollback(plan, rb);
  // T01 untouched: 全字段保留
  const t01Old = plan.tasks[0];
  const t01New = newPlan.tasks[0];
  expect(t01New.status).toBe(TaskStatusEnum.complete);
  expect(t01Old.status).toBe(TaskStatusEnum.complete);
  expect(t01New.attempt).toBe(5);
  expect(t01Old.attempt).toBe(5);
  expect(t01New.allowed_write_paths).toEqual(t01Old.allowed_write_paths);
  expect(t01New.acceptance_refs).toEqual(t01Old.acceptance_refs);
  // T02 downgrade
  expect(newPlan.tasks[1].status).toBe(TaskStatusEnum.pending);
  expect(newPlan.tasks[1].attempt).toBe(1);
});

// ---------- changes_semantics 字段 ----------

test("[py: test_changes_semantics_flag_passthrough] changes_semantics=true 透传", () => {
  const plan = mkPlan(mkTask("T01", ["AC-001"]));
  const rb = computeRollback(plan, mkAmendment("AC-001"), true);
  expect(rb.changes_semantics).toBe(true);
});

test("[py: test_changes_semantics_default_false] 默认 changes_semantics=false", () => {
  const plan = mkPlan(mkTask("T01", ["AC-001"]));
  const rb = computeRollback(plan, mkAmendment("AC-001"));
  expect(rb.changes_semantics).toBe(false);
});

// ---------- 端到端 ----------

test("[py: test_end_to_end_amendment_workflow] 4-task 端到端 + apply 后状态分布", () => {
  const plan = mkPlan(
    mkTask("T01", ["AC-001", "AC-002"], { status: TaskStatusEnum.complete, attempt: 1 }),
    mkTask("T02", ["AC-002"], { status: TaskStatusEnum.running, attempt: 2 }),
    mkTask("T03", ["AC-003"], { status: TaskStatusEnum.pending, attempt: 0 }),
    mkTask("T04", ["AC-001"], { status: TaskStatusEnum.complete, attempt: 3 }),
  );
  const rb = computeRollback(plan, mkAmendment("AC-001"), false);

  // RollbackPlan 字段
  expect(new Set(rb.touched_acceptance_refs)).toEqual(new Set(["AC-001"]));
  expect(new Set(rb.expanded_acceptance_refs)).toEqual(new Set(["AC-001", "AC-002"]));
  expect(new Set(rb.downgrade_to_pending)).toEqual(new Set(["T01", "T04"]));
  expect(new Set(rb.recall_to_pending)).toEqual(new Set(["T02"]));
  expect(new Set(rb.untouched)).toEqual(new Set(["T03"]));
  expect(rb.changes_semantics).toBe(false);

  // apply 后状态
  const newPlan = applyRollback(plan, rb);
  const byId = new Map(newPlan.tasks.map((t) => [t.id, t]));
  expect(byId.get("T01")!.status).toBe(TaskStatusEnum.pending);
  expect(byId.get("T01")!.attempt).toBe(1); // 保留
  expect(byId.get("T02")!.status).toBe(TaskStatusEnum.pending);
  expect(byId.get("T02")!.attempt).toBe(2); // 保留
  expect(byId.get("T03")!.status).toBe(TaskStatusEnum.pending); // 未变
  expect(byId.get("T03")!.attempt).toBe(0);
  expect(byId.get("T04")!.status).toBe(TaskStatusEnum.pending);
  expect(byId.get("T04")!.attempt).toBe(3); // 保留

  // summarize 不抛错且包含关键信息
  const s = summarize(rb);
  expect(s).toContain("T01");
  expect(s).toContain("T04");
  expect(s).toContain("T02");
  expect(s).toContain("AC-001");
  expect(s).toContain("AC-002");
});

test("[py: test_summarize_handles_empty_lists] summarize 全空列表不抛错", () => {
  const rb: RollbackPlan = {
    touched_acceptance_refs: [],
    expanded_acceptance_refs: [],
    downgrade_to_pending: [],
    recall_to_pending: [],
    untouched: [],
    changes_semantics: false,
  };
  const s = summarize(rb);
  expect(s).toContain("无"); // _fmt 空列表输出 "(无)"
});
