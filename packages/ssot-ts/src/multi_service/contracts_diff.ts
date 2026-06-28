/**
 * §11.2 "契约改没改" 的权威判定源 (第 1 层, TS 版, 等价 Python
 * `loop_engineering/multi_service/contracts_diff.py`)。
 *
 * 规范源: design §11.2 —— service-contracts.yaml 的版本 diff 是契约变更的权威触发源
 * (worker 在 summary 里声明的 ContractChange 是第 2 层及早信号, 不一致时以权威为准)。
 *
 * 变更类型: added / removed / surface_changed / consumer_added / consumer_removed /
 * integration_case_changed。surface_changed 是触发"契约变更传播" (§11.2) 的唯一信号 ——
 * consumer 变更只改成员, 不改接口契约本身, 不传播 (但记入 diff)。
 *
 * 注意: 本模块的 `ContractChange` 是 diff 结果记录, 与 schema 层
 * `artifacts.ts` 里那个 worker 自报告用的 `ContractChange ({name})` 同名但语义不同。
 * 本文件内部自定义, 不复用 schema 的同名类型。
 */
import type { ServiceContracts } from "../schema/service_contracts.js";

/**
 * 单个 contract 在 before/after 之间的变更。
 */
export interface ContractChange {
  /** contract id。 */
  contract_id: string;
  /**
   * 变更类型: added / removed / surface_changed / consumer_added /
   * consumer_removed / integration_case_changed。
   */
  change_type: string;
  /** 旧值 (added 时为 null)。 */
  before: string | null;
  /** 新值 (removed 时为 null)。 */
  after: string | null;
}

/**
 * 对比两个版本的 service-contracts.yaml, 返回所有变更。
 *
 * 按 contract id 配对:
 * - 仅在 after: added。
 * - 仅在 before: removed。
 * - 两边都有: 对比 surface / consumers / integration_cases, 任一变化生成对应 change_type。
 *   surface 变更优先于 consumer 变更 (它触发传播), 同一 contract 可同时多条 change。
 */
export function diffContracts(
  before: ServiceContracts,
  after: ServiceContracts,
): ContractChange[] {
  const beforeById = new Map(before.contracts.map((c) => [c.id, c]));
  const afterById = new Map(after.contracts.map((c) => [c.id, c]));
  const changes: ContractChange[] = [];

  // 仅在 after: added (按 id 字典序)
  const addedIds = [...afterById.keys()]
    .filter((id) => !beforeById.has(id))
    .sort();
  for (const cid of addedIds) {
    const c = afterById.get(cid)!;
    changes.push({
      contract_id: cid,
      change_type: "added",
      before: null,
      after: c.surface,
    });
  }

  // 仅在 before: removed (按 id 字典序)
  const removedIds = [...beforeById.keys()]
    .filter((id) => !afterById.has(id))
    .sort();
  for (const cid of removedIds) {
    const c = beforeById.get(cid)!;
    changes.push({
      contract_id: cid,
      change_type: "removed",
      before: c.surface,
      after: null,
    });
  }

  // 两边都有 (按 id 字典序)
  const commonIds = [...beforeById.keys()]
    .filter((id) => afterById.has(id))
    .sort();
  for (const cid of commonIds) {
    const b = beforeById.get(cid)!;
    const a = afterById.get(cid)!;
    if (b.surface !== a.surface) {
      changes.push({
        contract_id: cid,
        change_type: "surface_changed",
        before: b.surface,
        after: a.surface,
      });
    }
    const bConsumers = new Set(b.consumers);
    const aConsumers = new Set(a.consumers);
    for (const added of [...aConsumers].filter((x) => !bConsumers.has(x)).sort()) {
      changes.push({
        contract_id: cid,
        change_type: "consumer_added",
        before: null,
        after: added,
      });
    }
    for (const removed of [...bConsumers]
      .filter((x) => !aConsumers.has(x))
      .sort()) {
      changes.push({
        contract_id: cid,
        change_type: "consumer_removed",
        before: removed,
        after: null,
      });
    }
    if (!arrayEqual(b.integration_cases, a.integration_cases)) {
      changes.push({
        contract_id: cid,
        change_type: "integration_case_changed",
        before: b.integration_cases.join(","),
        after: a.integration_cases.join(","),
      });
    }
  }

  return changes;
}

/** 顺序敏感的数组相等 (等价 Python `list(b) != list(a)` 取反)。 */
function arrayEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** 是否存在 surface_changed (§11.2 传播的权威信号)。 */
export function hasSurfaceChange(diff: ContractChange[]): boolean {
  return diff.some((c) => c.change_type === "surface_changed");
}
