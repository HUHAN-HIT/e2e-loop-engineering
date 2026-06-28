/**
 * propagation 等价测试 (P4-M5, §11.2)。
 *
 * 行为权威: Python `tests/test_propagation.py` + `loop_engineering/multi_service/propagation.py`。
 * 被测实现: `packages/ssot-ts/src/multi_service/propagation.ts`。
 *
 * 覆盖: surface 变更找到 consumer task 并加隐式边、仅 surface 才传播 (consumer_added 不触发)、
 * 无 consumer 不影响、applyImplicitDependencies 去重已有边、不可变 (不改原 plan)。
 */
import { test, expect } from "bun:test";

import {
  applyImplicitDependencies,
  propagateContractChanges,
} from "../../packages/ssot-ts/src/multi_service/propagation.js";
import type { ContractChange } from "../../packages/ssot-ts/src/multi_service/contracts_diff.js";
import type { Task, TaskPlan } from "@e2e-loop/ssot";
import { ServiceContractsSchema, TaskSchema, TaskPlanSchema } from "@e2e-loop/ssot";

function mkTask(
  tid: string,
  service: string,
  opts: {
    provides?: string[];
    consumes?: string[];
    depends_on?: string[];
  } = {},
): Task {
  return TaskSchema.parse({
    id: tid,
    title: tid,
    allowed_write_paths: [`src/${service}/**`],
    acceptance_refs: [`AC-${tid}`],
    service,
    provides_contracts: opts.provides ?? [],
    consumes_contracts: opts.consumes ?? [],
    depends_on: opts.depends_on ?? [],
  });
}

function mkPlan(tasks: Task[]): TaskPlan {
  return TaskPlanSchema.parse({ complexity: "complex", tasks });
}

// ---------- propagate ----------

test("[py: TestPropagate.test_propagate_finds_consumer_tasks] surface 变更 → 找到 consumer task 并加边", () => {
  const contracts = ServiceContractsSchema.parse({
    contracts: [
      {
        id: "C-auth-token",
        provider: "auth",
        consumers: ["gateway", "billing"],
        surface: "token",
      },
    ],
  });
  const plan = mkPlan([
    mkTask("T-auth", "auth", { provides: ["C-auth-token"] }),
    mkTask("T-gw", "gateway", { consumes: ["C-auth-token"] }),
    mkTask("T-bill", "billing", { consumes: ["C-auth-token"] }),
  ]);
  const diff: ContractChange[] = [
    {
      contract_id: "C-auth-token",
      change_type: "surface_changed",
      before: "token",
      after: "token-v2",
    },
  ];
  const result = propagateContractChanges(plan, contracts, diff);
  expect(result.changed_contracts).toEqual(["C-auth-token"]);
  expect(new Set(result.affected_consumer_tasks)).toEqual(new Set(["T-gw", "T-bill"]));
  expect(result.implicit_dependencies_added).toContainEqual(["T-gw", "T-auth"]);
  expect(result.implicit_dependencies_added).toContainEqual(["T-bill", "T-auth"]);
});

test("[py: TestPropagate.test_only_surface_changes_propagate] consumer_added 不触发传播", () => {
  const contracts = ServiceContractsSchema.parse({
    contracts: [{ id: "C1", provider: "auth", consumers: ["gateway"], surface: "v1" }],
  });
  const plan = mkPlan([
    mkTask("T-auth", "auth", { provides: ["C1"] }),
    mkTask("T-gw", "gateway", { consumes: ["C1"] }),
  ]);
  const diff: ContractChange[] = [
    { contract_id: "C1", change_type: "consumer_added", before: null, after: "x" },
  ];
  const result = propagateContractChanges(plan, contracts, diff);
  expect(result.changed_contracts).toEqual([]);
  expect(result.implicit_dependencies_added).toEqual([]);
});

test("[py: TestPropagate.test_no_consumers_no_affected] 无 consumer → 无影响", () => {
  const contracts = ServiceContractsSchema.parse({
    contracts: [{ id: "C1", provider: "auth", consumers: [], surface: "v1" }],
  });
  const plan = mkPlan([mkTask("T-auth", "auth", { provides: ["C1"] })]);
  const diff: ContractChange[] = [
    { contract_id: "C1", change_type: "surface_changed", before: "v1", after: "v2" },
  ];
  const result = propagateContractChanges(plan, contracts, diff);
  expect(result.affected_consumer_tasks).toEqual([]);
  expect(result.implicit_dependencies_added).toEqual([]);
});

// ---------- applyImplicitDependencies ----------

test("[py: TestApplyImplicitDependencies.test_dedup_existing] 已有边去重 (count == 1)", () => {
  const contracts = ServiceContractsSchema.parse({
    contracts: [{ id: "C1", provider: "auth", consumers: ["gateway"], surface: "v1" }],
  });
  const plan = mkPlan([
    mkTask("T-auth", "auth", { provides: ["C1"] }),
    mkTask("T-gw", "gateway", { consumes: ["C1"], depends_on: ["T-auth"] }),
  ]);
  const diff: ContractChange[] = [
    { contract_id: "C1", change_type: "surface_changed", before: "v1", after: "v2" },
  ];
  const prop = propagateContractChanges(plan, contracts, diff);
  const newPlan = applyImplicitDependencies(plan, prop);
  const gw = newPlan.tasks.find((t) => t.id === "T-gw")!;
  expect(gw.depends_on.filter((d) => d === "T-auth").length).toBe(1);
});

test("[py: TestApplyImplicitDependencies.test_new_instance_does_not_mutate_original] 不改原 plan", () => {
  const contracts = ServiceContractsSchema.parse({
    contracts: [{ id: "C1", provider: "auth", consumers: ["gateway"], surface: "v1" }],
  });
  const plan = mkPlan([
    mkTask("T-auth", "auth", { provides: ["C1"] }),
    mkTask("T-gw", "gateway", { consumes: ["C1"] }),
  ]);
  const diff: ContractChange[] = [
    { contract_id: "C1", change_type: "surface_changed", before: "v1", after: "v2" },
  ];
  const prop = propagateContractChanges(plan, contracts, diff);
  const newPlan = applyImplicitDependencies(plan, prop);
  // 原 plan 的 T-gw.depends_on 仍为空
  const origGw = plan.tasks.find((t) => t.id === "T-gw")!;
  expect(origGw.depends_on).toEqual([]);
  // 新 plan 的 T-gw 加了依赖
  const newGw = newPlan.tasks.find((t) => t.id === "T-gw")!;
  expect(newGw.depends_on).toContain("T-auth");
});
