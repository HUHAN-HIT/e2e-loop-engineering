/**
 * §2.1 计划自检 (全部客观可判定项) —— TS 版, 等价 Python
 * `loop_engineering/checklists/plan_check.py`。
 *
 * 规范源: design §2.1 计划自检 + §11.2 多服务契约自检。
 * 不做语义判断 ("summary 是否充分"), 只做有/无、在/不在、成环/无环。
 *
 * 调用入口 checkPlan:
 * - 单服务 run (contracts=undefined) 跑前 4 项核心检查。
 * - 多服务 run 追加 3 项契约检查 (§11.2)。
 * - pathOverlapFn 通过参数注入 (= S3.pathGlobsOverlap), 解耦避免循环依赖;
 *   缺省时回退真实 pathGlobsOverlap, 避免公共调用漏传后误放行。
 *
 * 与 Python 的差异处理:
 * - dataclass(frozen=True) → 纯 readonly 接口 (TS 不强制冻结, 语义上视作只读)。
 * - all_pass @property → 工厂函数计算后写入对象字段 (与 checks_eval 子包风格一致)。
 * - f"{x!r}" repr → pyRepr (字符串加单引号), 测试只断言关键子串。
 */
import { pathGlobsOverlap as pathGlobsOverlapRef } from "../scheduling/path_overlap.js";
import type { ServiceContracts } from "../schema/service_contracts.js";
import type { TaskPlan } from "../schema/task_plan.js";

/** 路径重叠判定注入签名 (= S3.pathGlobsOverlap)。 */
export type PathOverlapFn = (a: readonly string[], b: readonly string[]) => boolean;

/**
 * 单条计划自检结果。
 *
 * check: 检查项标识 (见模块 docstring 列表)。
 * passed: 该项是否通过。
 * detail: 失败时的诊断信息 (哪个 AC / 哪个 task 出问题)。
 */
export interface PlanCheckItem {
  readonly check: string;
  readonly passed: boolean;
  readonly detail: string;
}

/** 计划自检汇总。all_pass = 至少有一项且全 pass。 */
export interface PlanCheckResult {
  readonly items: PlanCheckItem[];
  /** 全部通过 = 至少有一项且全 pass。 */
  readonly all_pass: boolean;
}

/** 把值渲染成近似 Python `repr` (字符串加单引号), 用于诊断信息回显。 */
function pyRepr(v: unknown): string {
  if (typeof v === "string") {
    return `'${v}'`;
  }
  return String(v);
}

/** 构造 PlanCheckItem (detail 缺省空串, 等价 Python `detail: str = ""`)。 */
function mkItem(check: string, passed: boolean, detail = ""): PlanCheckItem {
  return { check, passed, detail };
}

/** 构造 PlanCheckResult, 计算 all_pass。 */
function mkResult(items: PlanCheckItem[]): PlanCheckResult {
  const allPass = items.length > 0 && items.every((i) => i.passed);
  return { items, all_pass: allPass };
}

/**
 * 跑 §2.1 全部检查项。
 *
 * 单服务 run (contracts=undefined) 跑前 4 项; 多服务 run 追加后 3 项契约检查。
 * pathOverlapFn 缺省时使用真实 pathGlobsOverlap, 避免公共调用漏传后误放行。
 */
export function checkPlan(
  plan: TaskPlan,
  options?: {
    contracts?: ServiceContracts | null;
    pathOverlapFn?: PathOverlapFn;
  },
): PlanCheckResult {
  const contracts = options?.contracts ?? null;
  // 缺省回退真实 pathGlobsOverlap (动态导入避免与 scheduling 子包潜在循环)。
  const pathOverlapFn: PathOverlapFn =
    options?.pathOverlapFn ?? defaultPathOverlapFn;

  const items: PlanCheckItem[] = [];
  items.push(...checkAcHasTaskAndTest(plan));
  items.push(...checkTaskHasRequiredFields(plan));
  items.push(...checkParallelPathsDisjoint(plan, pathOverlapFn));
  items.push(...checkDepsNoCycle(plan));

  if (contracts !== null) {
    items.push(...checkContractsHaveProviderConsumerTasks(plan, contracts));
    items.push(...checkContractsHaveIntegrationCases(contracts));
    items.push(...checkProviderUpdatesContractsYaml(plan, contracts));
  }

  return mkResult(items);
}

/**
 * 缺省 pathOverlapFn: 真实 pathGlobsOverlap (从 scheduling 子包引)。
 *
 * 用独立函数包一层而非顶层 import, 与 Python 的"函数内 lazy import"对齐,
 * 避免 plan_check ↔ scheduling 潜在循环依赖。
 */
function defaultPathOverlapFn(a: readonly string[], b: readonly string[]): boolean {
  // path_overlap 不反向依赖 checklists, 顶层 import 无循环风险。
  return pathGlobsOverlapRef(a, b);
}

// ---------------------------------------------------------------------------
// §2.1 前 4 项 (单服务 / 多服务都要跑)
// ---------------------------------------------------------------------------

/**
 * 每个 AC 至少映射一个 task 且该 task 有至少一条 test。
 *
 * 扫 plan.tasks, 收集所有 acceptance_refs。对每条 ref:
 * - 出现在某 task.acceptance_refs 且该 task.tests 非空 → pass
 * - 否则 fail, detail='AC <ref> 缺 task 或缺测试'。
 */
function checkAcHasTaskAndTest(plan: TaskPlan): PlanCheckItem[] {
  const items: PlanCheckItem[] = [];
  // AC -> 是否至少有一个对应 task 且该 task 有 test。
  const acHasTaskWithTest = new Map<string, boolean>();
  for (const t of plan.tasks) {
    for (const ref of t.acceptance_refs) {
      if (t.tests.length > 0) {
        acHasTaskWithTest.set(ref, true);
      } else if (!acHasTaskWithTest.has(ref)) {
        // 没出现 True 就保持 False (等价 Python setdefault)
        acHasTaskWithTest.set(ref, false);
      }
    }
  }

  for (const ref of [...acHasTaskWithTest.keys()].sort()) {
    const ok = acHasTaskWithTest.get(ref)!;
    items.push(
      mkItem("ac_has_task_and_test", ok, ok ? "" : `AC ${pyRepr(ref)} 缺 task 或缺测试`),
    );
  }
  return items;
}

/**
 * 每个 task 有 allowed_write_paths / acceptance_refs。
 *
 * depends_on 允许空 (叶子 task)。allowed_write_paths 与 acceptance_refs 空则 fail。
 */
function checkTaskHasRequiredFields(plan: TaskPlan): PlanCheckItem[] {
  const items: PlanCheckItem[] = [];
  for (const t of plan.tasks) {
    const missing: string[] = [];
    if (t.allowed_write_paths.length === 0) {
      missing.push("allowed_write_paths");
    }
    if (t.acceptance_refs.length === 0) {
      missing.push("acceptance_refs");
    }
    // depends_on 可空, 不查。
    if (missing.length > 0) {
      items.push(
        mkItem(
          "task_has_fields",
          false,
          `task ${t.id} 缺必填字段: ${pyList(missing)}`,
        ),
      );
    } else {
      items.push(mkItem("task_has_fields", true, `task ${t.id}`));
    }
  }
  return items;
}

/** 渲染字符串列表为近似 Python list repr `['a', 'b']` (测试只断言子串)。 */
function pyList(xs: readonly string[]): string {
  return `[${xs.map((x) => pyRepr(x)).join(", ")}]`;
}

/**
 * 可并行 task (depends_on 闭包内无相互依赖) 的写路径不重叠。
 *
 * 实现简化: 对每对 (a, b), 若 a 不依赖 b 且 b 不依赖 a (含传递闭包) 视为可并行;
 * exclusive 不算违规 (它本就独占)。路径重叠用注入的 pathOverlapFn。
 */
function checkParallelPathsDisjoint(
  plan: TaskPlan,
  pathOverlapFn: PathOverlapFn,
): PlanCheckItem[] {
  const items: PlanCheckItem[] = [];
  const tasks = [...plan.tasks];
  // 直接依赖集合
  const deps = new Map<string, Set<string>>();
  for (const t of tasks) {
    deps.set(t.id, new Set(t.depends_on));
  }

  const reachable = (start: string): Set<string> => {
    const seen = new Set<string>();
    const stack: string[] = [...(deps.get(start) ?? [])];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur)) {
        continue;
      }
      seen.add(cur);
      stack.push(...(deps.get(cur) ?? []));
    }
    return seen;
  };

  const closure = new Map<string, Set<string>>();
  for (const tid of deps.keys()) {
    closure.set(tid, reachable(tid));
  }

  for (let i = 0; i < tasks.length; i += 1) {
    const a = tasks[i]!;
    for (let k = i + 1; k < tasks.length; k += 1) {
      const b = tasks[k]!;
      // 互相在闭包内即有依赖, 不算可并行
      if (closure.get(a.id)!.has(b.id) || closure.get(b.id)!.has(a.id)) {
        continue;
      }
      // exclusive task 独占, 不算路径冲突 (本就是串行排他的)
      if (a.exclusive || b.exclusive) {
        continue;
      }
      if (pathOverlapFn(a.allowed_write_paths, b.allowed_write_paths)) {
        items.push(
          mkItem(
            "parallel_paths_disjoint",
            false,
            `可并行 task ${a.id} 与 ${b.id} 的 allowed_write_paths 重叠`,
          ),
        );
      }
    }
  }
  if (!items.some((it) => it.check === "parallel_paths_disjoint" && !it.passed)) {
    items.push(mkItem("parallel_paths_disjoint", true, "无重叠"));
  }
  return items;
}

/** depends_on 不成环 (DFS 三色标记)。 */
function checkDepsNoCycle(plan: TaskPlan): PlanCheckItem[] {
  const tasks = new Map<string, Set<string>>();
  for (const t of plan.tasks) {
    tasks.set(t.id, new Set(t.depends_on));
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const tid of tasks.keys()) {
    color.set(tid, WHITE);
  }
  let hasCycle = false;

  const dfs = (node: string): void => {
    color.set(node, GRAY);
    for (const nxt of tasks.get(node) ?? []) {
      if (!color.has(nxt)) {
        // 依赖不存在的 task, 视为有效但孤立的标识, 不计环
        continue;
      }
      if (color.get(nxt) === GRAY) {
        hasCycle = true;
        return;
      }
      if (color.get(nxt) === WHITE) {
        dfs(nxt);
        if (hasCycle) {
          return;
        }
      }
    }
    color.set(node, BLACK);
  };

  for (const tid of tasks.keys()) {
    if (color.get(tid) === WHITE) {
      dfs(tid);
      if (hasCycle) {
        break;
      }
    }
  }

  return [
    mkItem("deps_no_cycle", !hasCycle, hasCycle ? "depends_on 存在环" : ""),
  ];
}

// ---------------------------------------------------------------------------
// §11.2 多服务契约自检 (仅在 contracts 提供时跑)
// ---------------------------------------------------------------------------

/**
 * 每 contract 的 provider/consumers 都必须有显式 contract task。
 *
 * 只存在同 service 的 task 不够; provider task 必须声明 provides_contracts,
 * consumer task 必须声明 consumes_contracts。否则多服务契约会被普通服务任务伪装通过。
 */
function checkContractsHaveProviderConsumerTasks(
  plan: TaskPlan,
  contracts: ServiceContracts,
): PlanCheckItem[] {
  const items: PlanCheckItem[] = [];

  for (const c of contracts.contracts) {
    const providerTasks = plan.tasks
      .filter((t) => t.service === c.provider && t.provides_contracts.includes(c.id))
      .map((t) => t.id);
    const missing: string[] = [];
    if (providerTasks.length === 0) {
      missing.push(
        `provider ${pyRepr(c.provider)} 缺声明 provides_contracts=${pyRepr(c.id)} 的 task`,
      );
    }

    for (const consumer of c.consumers) {
      const consumerTasks = plan.tasks
        .filter((t) => t.service === consumer && t.consumes_contracts.includes(c.id))
        .map((t) => t.id);
      if (consumerTasks.length === 0) {
        missing.push(
          `consumer ${pyRepr(consumer)} 缺声明 consumes_contracts=${pyRepr(c.id)} 的 task`,
        );
      }
    }

    if (missing.length > 0) {
      items.push(
        mkItem(
          "contract_provider_consumer_have_tasks",
          false,
          `contract ${c.id}: ${missing.join("; ")}`,
        ),
      );
    } else {
      items.push(
        mkItem("contract_provider_consumer_have_tasks", true, `contract ${c.id}`),
      );
    }
  }
  return items;
}

/** 每 contract 至少一个 integration_cases。 */
function checkContractsHaveIntegrationCases(
  contracts: ServiceContracts,
): PlanCheckItem[] {
  const items: PlanCheckItem[] = [];
  for (const c of contracts.contracts) {
    const ok = c.integration_cases.length > 0;
    items.push(
      mkItem(
        "contract_has_integration_case",
        ok,
        ok ? "" : `contract ${c.id} 无 integration_cases`,
      ),
    );
  }
  return items;
}

/**
 * provider task 若触及契约 surface, contracts 里需有该 contract。
 *
 * 静态可判的部分: task.provides_contracts 中每个 id 都能在 contracts 找到对应记录。
 * (真实 surface diff 由 contracts_diff 做, 这里只查静态登记的对应性。)
 */
function checkProviderUpdatesContractsYaml(
  plan: TaskPlan,
  contracts: ServiceContracts,
): PlanCheckItem[] {
  const items: PlanCheckItem[] = [];
  const contractIds = new Set(contracts.contracts.map((c) => c.id));
  for (const t of plan.tasks) {
    if (t.provides_contracts.length === 0) {
      continue;
    }
    for (const cid of t.provides_contracts) {
      if (!contractIds.has(cid)) {
        items.push(
          mkItem(
            "provider_updates_contracts_yaml",
            false,
            `task ${t.id} 声明 provides_contracts 含 ${pyRepr(cid)}, 但 service-contracts.yaml 未登记`,
          ),
        );
      }
    }
  }
  if (!items.some((it) => it.check === "provider_updates_contracts_yaml" && !it.passed)) {
    items.push(
      mkItem(
        "provider_updates_contracts_yaml",
        true,
        "所有 provider task 声明的 contract 均已登记",
      ),
    );
  }
  return items;
}
