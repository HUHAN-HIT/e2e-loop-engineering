/**
 * §2.3 收口自检 —— TS 版, 等价 Python `loop_engineering/checklists/wrap_up_check.py`。
 *
 * 规范源: design §2.3 + §11.3 (多服务集成自检)。
 *
 * 五项客观检查:
 * 1. all_tasks_tests_green —— 全部 task 任务自检通过
 * 2. key_diffs_md_ready —— 关键改动清单齐备
 * 3. scope_consistent —— 计划/实际 scope 一致 (无异常膨胀)
 * 4. all_hard_gates_pass —— risk:high/exclusive task 的 key-diffs 硬 gate 通过
 * 5. integration_tests_green —— 多服务时所有契约集成用例绿 (单服务跳过)
 *
 * 与 Python 的差异处理:
 * - dataclass(frozen=True) → readonly 接口; all_pass @property → 工厂函数计算后写入字段。
 * - dict[str, X | None] → Record / Map 均接受; KeyDiffsFile.is_meaningful() → isMeaningful(file)。
 * - sorted(extras)[:5] 等列表回显用 pyList (近似 Python list repr), 测试只断言子串。
 */
import {
  GateStatus,
  allHardGatesPass,
  validateMany,
} from "./key_diffs_gate.js";
import type { KeyDiffsGateResult } from "./key_diffs_gate.js";
import type { TaskCheckResult } from "./task_check.js";
import { isMeaningful } from "../schema/artifacts.js";
import type { KeyDiffsFile } from "../schema/artifacts.js";
import type { TaskPlan } from "../schema/task_plan.js";

/** task_id → 值 的查表 (兼容普通对象与 Map)。 */
type Lookup<V> = Record<string, V> | Map<string, V>;

function lookupGet<V>(table: Lookup<V>, key: string): V | undefined {
  return table instanceof Map ? table.get(key) : table[key];
}

/** 单条收口自检结果。 */
export interface WrapUpCheckItem {
  readonly check: string;
  readonly passed: boolean;
  readonly detail: string;
}

/** 收口自检汇总。all_pass = 至少一项且全 pass。 */
export interface WrapUpCheckResult {
  readonly items: WrapUpCheckItem[];
  /** 全部通过 = 至少一项且全 pass。 */
  readonly all_pass: boolean;
}

/** 构造 WrapUpCheckItem (detail 缺省空串)。 */
function mkItem(check: string, passed: boolean, detail = ""): WrapUpCheckItem {
  return { check, passed, detail };
}

/** 构造 WrapUpCheckResult, 计算 all_pass。 */
function mkResult(items: WrapUpCheckItem[]): WrapUpCheckResult {
  const allPass = items.length > 0 && items.every((i) => i.passed);
  return { items, all_pass: allPass };
}

/** 渲染字符串列表为近似 Python list repr `['a', 'b']` (测试只断言子串)。 */
function pyList(xs: readonly string[]): string {
  return `[${xs.map((x) => `'${x}'`).join(", ")}]`;
}

/**
 * 跑 §2.3 全部。
 *
 * @param plan 计划。
 * @param taskResults 每 task_id -> 任务自检结果。缺失的 task 视为未通过。
 * @param keyDiffsByTask 每 task_id -> key-diffs.yaml (null = 未提交或解析失败)。
 * @param options.integrationResults 多服务时 case_id -> green? null/undefined 跳过该项。
 * @param options.plannedScopeFiles 计划期声明的预期文件清单。
 * @param options.actualScopeFiles 收口时的实际改动文件清单。
 * @param options.requiresIntegration 多服务/契约 run 为 true; 缺 integrationResults 时不得软跳过。
 */
export function checkWrapUp(
  plan: TaskPlan,
  taskResults: Lookup<TaskCheckResult>,
  keyDiffsByTask: Lookup<KeyDiffsFile | null | undefined>,
  options?: {
    integrationResults?: Lookup<boolean> | null;
    plannedScopeFiles?: string[] | null;
    actualScopeFiles?: string[] | null;
    requiresIntegration?: boolean;
  },
): WrapUpCheckResult {
  const integrationResults = options?.integrationResults ?? null;
  const plannedScopeFiles = options?.plannedScopeFiles ?? null;
  const actualScopeFiles = options?.actualScopeFiles ?? null;
  const requiresIntegration = options?.requiresIntegration ?? false;

  const items: WrapUpCheckItem[] = [];
  items.push(checkAllTasksTestsGreen(plan, taskResults));
  items.push(checkKeyDiffsMdReady(plan, keyDiffsByTask));
  items.push(checkScopeConsistent(plannedScopeFiles, actualScopeFiles));
  items.push(checkAllHardGatesPass(plan, keyDiffsByTask));
  items.push(checkIntegrationTestsGreen(integrationResults, requiresIntegration));
  return mkResult(items);
}

/** 全部 task 任务自检通过。 */
function checkAllTasksTestsGreen(
  plan: TaskPlan,
  taskResults: Lookup<TaskCheckResult>,
): WrapUpCheckItem {
  const missing: string[] = [];
  const failed: string[] = [];
  for (const t of plan.tasks) {
    const r = lookupGet(taskResults, t.id);
    if (r === undefined || r === null) {
      missing.push(t.id);
      continue;
    }
    if (!r.all_pass) {
      failed.push(t.id);
    }
  }
  if (missing.length > 0 || failed.length > 0) {
    const detailParts: string[] = [];
    if (missing.length > 0) {
      detailParts.push(`缺自检结果: ${pyList(missing)}`);
    }
    if (failed.length > 0) {
      detailParts.push(`自检未全绿: ${pyList(failed)}`);
    }
    return mkItem("all_tasks_tests_green", false, detailParts.join("; "));
  }
  return mkItem(
    "all_tasks_tests_green",
    true,
    `${plan.tasks.length} task 全部自检通过`,
  );
}

/**
 * 每个有关键改动的 task 已产出 key-diffs.yaml。
 *
 * 客观判: 至少有 task 提交过非空 key-diffs 即视为"清单齐备"。严格硬 gate 在
 * all_hard_gates_pass 项查。
 */
function checkKeyDiffsMdReady(
  plan: TaskPlan,
  keyDiffsByTask: Lookup<KeyDiffsFile | null | undefined>,
): WrapUpCheckItem {
  const nonEmptySubmitters: string[] = [];
  for (const t of plan.tasks) {
    const kd = lookupGet(keyDiffsByTask, t.id);
    if (kd !== null && kd !== undefined && isMeaningful(kd)) {
      nonEmptySubmitters.push(t.id);
    }
  }
  if (nonEmptySubmitters.length === 0) {
    return mkItem(
      "key_diffs_md_ready",
      false,
      "无任何 task 提交非空 key-diffs.yaml",
    );
  }
  return mkItem(
    "key_diffs_md_ready",
    true,
    `${nonEmptySubmitters.length} task 提交了 key-diffs`,
  );
}

/**
 * scope 与计划一致 (无计划外大范围改动)。
 *
 * 客观判: actual 是 planned 的子集 (允许计划内文件少于预期), 或新增文件不超过
 * planned 数量的 50% (允许少量计划外文件如新加的小工具)。两者任一为 null 时软 pass。
 */
function checkScopeConsistent(
  planned: string[] | null,
  actual: string[] | null,
): WrapUpCheckItem {
  if (planned === null || actual === null) {
    return mkItem("scope_consistent", true, "planned/actual scope 未提供, 跳过");
  }
  const plannedSet = new Set(planned);
  const actualSet = new Set(actual);
  const extras = [...actualSet].filter((x) => !plannedSet.has(x));
  if (extras.length === 0) {
    return mkItem(
      "scope_consistent",
      true,
      `actual (${actualSet.size}) 全在 planned (${plannedSet.size}) 范围内`,
    );
  }
  // 允许少量膨胀: extras <= planned 的 50%, 且绝对值 <= 5
  const allowRatio = Math.max(1, Math.floor(plannedSet.size / 2));
  const allowAbs = 5;
  if (extras.length <= allowRatio && extras.length <= allowAbs) {
    return mkItem(
      "scope_consistent",
      true,
      `少量计划外文件 ${pyList([...extras].sort())} (允许范围内)`,
    );
  }
  return mkItem(
    "scope_consistent",
    false,
    `实际改动异常膨胀: planned=${plannedSet.size}, 实际新增 ${extras.length} 个计划外文件 ${pyList(
      [...extras].sort().slice(0, 5),
    )}...`,
  );
}

/** risk:high / exclusive task 的 key-diffs 硬 gate 通过 (复用 key_diffs_gate)。 */
function checkAllHardGatesPass(
  plan: TaskPlan,
  keyDiffsByTask: Lookup<KeyDiffsFile | null | undefined>,
): WrapUpCheckItem {
  const results: KeyDiffsGateResult[] = validateMany([...plan.tasks], keyDiffsByTask);
  if (allHardGatesPass(results)) {
    const failed = results.filter((r) => r.status === GateStatus.FAIL);
    // allHardGatesPass 仅判 FAIL, 通过即无 FAIL
    return mkItem(
      "all_hard_gates_pass",
      true,
      `无硬 gate FAIL (共 ${results.length} 项校验, ${failed.length} 项 FAIL)`,
    );
  }
  const fails = results.filter((r) => r.status === GateStatus.FAIL);
  return mkItem(
    "all_hard_gates_pass",
    false,
    fails.map((r) => `${r.task_id}: ${r.reason}`).join("; "),
  );
}

/** 多服务: 所有契约集成用例绿。单服务可跳过。 */
function checkIntegrationTestsGreen(
  integrationResults: Lookup<boolean> | null,
  required: boolean,
): WrapUpCheckItem {
  if (integrationResults === null) {
    if (required) {
      return mkItem(
        "integration_tests_green",
        false,
        "多服务/契约 run 缺 integration_results, 不可跳过",
      );
    }
    return mkItem("integration_tests_green", true, "单服务 run, 跳过");
  }

  // 归一为 entries, 兼容 Map 与普通对象。
  const entries: [string, boolean][] =
    integrationResults instanceof Map
      ? [...integrationResults.entries()]
      : Object.entries(integrationResults);

  if (entries.length === 0) {
    return mkItem(
      "integration_tests_green",
      false,
      "多服务 run 但无集成用例结果",
    );
  }
  const failedCases = entries.filter(([, ok]) => !ok).map(([cid]) => cid);
  if (failedCases.length > 0) {
    return mkItem(
      "integration_tests_green",
      false,
      `集成用例未全绿: ${pyList(failedCases)}`,
    );
  }
  return mkItem(
    "integration_tests_green",
    true,
    `${entries.length} 个集成用例全绿`,
  );
}
