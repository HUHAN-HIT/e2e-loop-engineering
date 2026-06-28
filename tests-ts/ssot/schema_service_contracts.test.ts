/**
 * service_contracts schema 等价测试 (P4-M1)。
 *
 * 行为权威: Python `tests/test_schema_service_contracts.py` +
 * `loop_engineering/schema/service_contracts.py`。
 * 被测实现: `packages/ssot-ts/src/schema/service_contracts.ts` (zod)。
 *
 * 覆盖: Contract 必填/可选默认、service-contracts 往返、id 唯一性校验、
 * service-map 往返、ServiceMapEntry extra=allow (passthrough)。
 */
import { test, expect } from "bun:test";
import {
  ContractSchema,
  ServiceContractsSchema,
  ServiceMapSchema,
  ServiceMapEntrySchema,
  parseServiceContracts,
  parseServiceMap,
} from "@e2e-loop/ssot";

test("[py: test_contract_fields] Contract 必填与可选字段默认", () => {
  const c = ContractSchema.parse({
    id: "C-auth-token",
    provider: "auth",
    consumers: ["gateway", "billing"],
    surface: "POST /token → { access_token, scope }",
    acceptance_refs: ["AC-007"],
    integration_cases: ["IT-001"],
  });
  expect(c.id).toBe("C-auth-token");
  expect(c.provider).toBe("auth");
  expect(c.consumers).toEqual(["gateway", "billing"]);
  expect(c.integration_cases).toContain("IT-001");

  // 可选字段默认
  const c2 = ContractSchema.parse({
    id: "C-x",
    provider: "auth",
    consumers: ["gateway"],
    surface: "x",
  });
  expect(c2.acceptance_refs).toEqual([]);
  expect(c2.integration_cases).toEqual([]);
});

test("[py: test_service_contracts_yaml_roundtrip] service-contracts 往返一致 + schema 默认", () => {
  const sc = parseServiceContracts({
    contracts: [
      {
        id: "C-auth-token",
        provider: "auth",
        consumers: ["gateway", "billing"],
        surface: "POST /token → { access_token, scope }",
        acceptance_refs: ["AC-007"],
        integration_cases: ["IT-001"],
      },
    ],
  });
  const sc2 = parseServiceContracts(JSON.parse(JSON.stringify(sc)));
  expect(sc2.schema).toBe("loop-engineering.service-contracts.v1");
  expect(sc2.contracts.length).toBe(1);
  expect(sc2.contracts[0].id).toBe("C-auth-token");
  expect(sc2.contracts[0].consumers).toEqual(["gateway", "billing"]);
});

test("[py: test_contract_id_uniqueness] 重复 contract id → 抛错 (信息含重复 id)", () => {
  expect(() =>
    ServiceContractsSchema.parse({
      contracts: [
        { id: "C-dup", provider: "auth", consumers: ["gw"], surface: "x" },
        { id: "C-dup", provider: "auth", consumers: ["gw2"], surface: "y" },
      ],
    }),
  ).toThrow(/C-dup/);
});

test("[py: test_contract_id_unique_ok] id 全不同 → 合法", () => {
  const sc = parseServiceContracts({
    contracts: [
      { id: "C-a", provider: "x", consumers: ["y"], surface: "a" },
      { id: "C-b", provider: "x", consumers: ["y"], surface: "b" },
    ],
  });
  expect(sc.contracts.length).toBe(2);
});

test("[py: test_service_map_roundtrip] service-map 往返一致 + schema 默认", () => {
  const sm = parseServiceMap({
    services: {
      auth: { worktree: "../wt/auth" },
      gateway: { worktree: "../wt/gateway" },
    },
  });
  const sm2 = parseServiceMap(JSON.parse(JSON.stringify(sm)));
  expect(sm2.schema).toBe("loop-engineering.service-map.v1");
  expect(sm2.services.auth.worktree).toBe("../wt/auth");
  expect(sm2.services.gateway.worktree).toBe("../wt/gateway");
});

test("[py: test_service_map_entry_extra_allow] ServiceMapEntry 允许未来加字段 (passthrough)", () => {
  const e = ServiceMapEntrySchema.parse({
    worktree: "../wt/auth",
    build_cmd: "make auth",
  });
  expect(e.worktree).toBe("../wt/auth");
  expect((e as Record<string, unknown>).build_cmd).toBe("make auth");
});

test("[补充] services 默认空 dict", () => {
  const sm = ServiceMapSchema.parse({});
  expect(sm.services).toEqual({});
});
