/**
 * contracts_diff 等价测试 (P4-M5, §11.2)。
 *
 * 行为权威: Python `tests/test_contracts_diff.py` + `loop_engineering/multi_service/contracts_diff.py`。
 * 被测实现: `packages/ssot-ts/src/multi_service/contracts_diff.ts`。
 *
 * 覆盖: added/removed、surface_changed (触发传播信号)、consumer_added/removed (不触发)、
 * integration_case_changed、无变更返回空。
 */
import { test, expect } from "bun:test";

import {
  diffContracts,
  hasSurfaceChange,
} from "../../packages/ssot-ts/src/multi_service/contracts_diff.js";
import type { Contract, ServiceContracts } from "@e2e-loop/ssot";
import { ContractSchema, ServiceContractsSchema } from "@e2e-loop/ssot";

function mkContracts(items: Contract[]): ServiceContracts {
  return ServiceContractsSchema.parse({ contracts: items });
}

function mkContract(opts: {
  cid?: string;
  provider?: string;
  consumers?: string[];
  surface?: string;
  integration_cases?: string[];
} = {}): Contract {
  return ContractSchema.parse({
    id: opts.cid ?? "C1",
    provider: opts.provider ?? "auth",
    consumers: opts.consumers ?? ["gateway"],
    surface: opts.surface ?? "v1",
    integration_cases: opts.integration_cases ?? ["ic1"],
  });
}

// ---------- added / removed ----------

test("[py: TestDiffAddedRemoved.test_diff_added] 仅 after 有 → added", () => {
  const before = mkContracts([mkContract({ cid: "C1" })]);
  const after = mkContracts([mkContract({ cid: "C1" }), mkContract({ cid: "C2" })]);
  const diff = diffContracts(before, after);
  const types = diff.filter((c) => c.contract_id === "C2").map((c) => c.change_type);
  expect(types).toContain("added");
});

test("[py: TestDiffAddedRemoved.test_diff_removed] 仅 before 有 → removed", () => {
  const before = mkContracts([mkContract({ cid: "C1" }), mkContract({ cid: "C2" })]);
  const after = mkContracts([mkContract({ cid: "C1" })]);
  const diff = diffContracts(before, after);
  const types = diff.filter((c) => c.contract_id === "C2").map((c) => c.change_type);
  expect(types).toContain("removed");
});

// ---------- surface 变更 ----------

test("[py: TestSurfaceChange.test_surface_changed] surface 改 → surface_changed + has_surface_change", () => {
  const before = mkContracts([mkContract({ cid: "C1", surface: "v1" })]);
  const after = mkContracts([mkContract({ cid: "C1", surface: "v2" })]);
  const diff = diffContracts(before, after);
  const types = diff.filter((c) => c.contract_id === "C1").map((c) => c.change_type);
  expect(types).toContain("surface_changed");
  expect(hasSurfaceChange(diff)).toBe(true);
});

test("[py: TestSurfaceChange.test_has_surface_change_false_when_only_consumer_changed] 只改 consumer → 无 surface 信号", () => {
  const before = mkContracts([mkContract({ cid: "C1", consumers: ["gateway"] })]);
  const after = mkContracts([
    mkContract({ cid: "C1", consumers: ["gateway", "billing"] }),
  ]);
  const diff = diffContracts(before, after);
  expect(hasSurfaceChange(diff)).toBe(false);
  const types = diff.map((c) => c.change_type);
  expect(types).toContain("consumer_added");
});

// ---------- 无变更 ----------

test("[py: TestNoChange.test_no_change_returns_empty] 无变更 → 空列表", () => {
  const before = mkContracts([mkContract({ cid: "C1" })]);
  const after = mkContracts([mkContract({ cid: "C1" })]);
  const diff = diffContracts(before, after);
  expect(diff).toEqual([]);
});

// ---------- integration_cases 变更 ----------

test("[py: TestIntegrationCaseChange.test_integration_cases_changed] integration_cases 改 → integration_case_changed", () => {
  const before = mkContracts([mkContract({ cid: "C1", integration_cases: ["ic1"] })]);
  const after = mkContracts([
    mkContract({ cid: "C1", integration_cases: ["ic1", "ic2"] }),
  ]);
  const diff = diffContracts(before, after);
  const types = diff.map((c) => c.change_type);
  expect(types).toContain("integration_case_changed");
});

// ---------- 仅 consumer 变更 ----------

test("[py: TestConsumerChangeOnly.test_consumer_removed] consumer 移除 → consumer_removed", () => {
  const before = mkContracts([
    mkContract({ cid: "C1", consumers: ["gateway", "billing"] }),
  ]);
  const after = mkContracts([mkContract({ cid: "C1", consumers: ["gateway"] })]);
  const diff = diffContracts(before, after);
  const types = diff.map((c) => c.change_type);
  expect(types).toContain("consumer_removed");
});
