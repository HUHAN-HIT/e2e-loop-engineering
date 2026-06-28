/**
 * §2.2 任务自检 (worker 完成单个 task 后的自核) —— TS 版, 等价 Python
 * `loop_engineering/checklists/task_check.py`。
 *
 * 规范源: design §2.2 + §0.2 关键约定 (tests_green 用 S4 eval_result.tests_green, 不信 worker 自报)。
 *
 * 四项全部客观可判定。关键点: tests_green 用 S4 的 eval_result.tests_green
 * (worker 自报告的 tests_green 是 hallucination 最可能落点, §0.2)。
 *
 * 与 Python 的差异处理:
 * - dataclass(frozen=True) → readonly 接口; all_pass @property → 工厂函数计算后写入字段。
 * - OOBDetection: Python 从 scheduling.actual_writes 引入的 dataclass。TS 侧 shared 的
 *   actual_writes 用了不同抽象 (ActualWrites/BoundaryCheck), 而本模块只消费 OOBDetection 的
 *   {is_oob, out_of_bounds, declared_paths} 三字段, 故此处定义等价 readonly 接口, 与 Python
 *   dataclass 字段一一对应 (测试构造同形对象), 不引入 shared 的不同形状。
 * - test_results 参数: Python 用 `del test_results` 显式声明不读 (防误用 worker 自报);
 *   TS 用 void 引用占位, 行为等价 (保留入参以便调用方持有)。
 */
import type { TaskCheckEvalResult } from "./checks_eval.js";
import { pathGlobsOverlap as pathGlobsOverlapRef } from "../scheduling/path_overlap.js";
import type { TestResults } from "../schema/artifacts.js";
import type { Task } from "../schema/task_plan.js";

/** 路径重叠判定注入签名 (= S3.pathGlobsOverlap)。 */
export type PathOverlapFn = (a: readonly string[], b: readonly string[]) => boolean;

/**
 * 越界写检测结果 (out-of-bounds), 等价 Python `scheduling.actual_writes.OOBDetection`。
 *
 * 本模块只消费 {is_oob, out_of_bounds, declared_paths}; task_id / actual_writes 字段
 * 与 Python dataclass 对齐保留, 便于调用方构造同形对象 (测试即如此)。
 */
export interface OOBDetection {
  readonly task_id: string;
  readonly declared_paths: string[];
  readonly actual_writes: string[];
  readonly out_of_bounds: string[];
  readonly is_oob: boolean;
}

/** 单条任务自检结果。 */
export interface TaskCheckItem {
  readonly check: string;
  readonly passed: boolean;
  readonly detail: string;
}

/** 单个 task 自检汇总。all_pass = 至少一项且全 pass。 */
export interface TaskCheckResult {
  readonly task_id: string;
  readonly items: TaskCheckItem[];
  /** 全部通过 = 至少一项且全 pass。 */
  readonly all_pass: boolean;
}

/** 构造 TaskCheckItem (detail 缺省空串)。 */
function mkItem(check: string, passed: boolean, detail = ""): TaskCheckItem {
  return { check, passed, detail };
}

/** 构造 TaskCheckResult, 计算 all_pass。 */
function mkResult(taskId: string, items: TaskCheckItem[]): TaskCheckResult {
  const allPass = items.length > 0 && items.every((i) => i.passed);
  return { task_id: taskId, items, all_pass: allPass };
}

/**
 * 跑 §2.2 四项任务自检。
 *
 * @param task 当前 task。
 * @param testResults worker 交回的 test-results.yaml (本模块不直接用其 tests_green)。
 * @param evalResult S4 求值结果, tests_green 用它的 .tests_green 而非 worker 自报。
 * @param options.oob actual_writes 越界检测结果; null/undefined 表示 actual_writes 不可用
 *   (单上下文兜底), diff_within_allowed_paths 项降级为软约束。
 * @param options.activeTasks 同期 active 的其它 task, 用于"不动其它 active task 写路径"。
 * @param options.pathOverlapFn 路径重叠判定注入 (= S3.pathGlobsOverlap)。
 *
 * Notes: testResults 参数保留以便扩展 / 调用方持有, 本模块不直接读它。
 */
export function checkTask(
  task: Task,
  testResults: TestResults,
  evalResult: TaskCheckEvalResult,
  options?: {
    oob?: OOBDetection | null;
    activeTasks?: Task[] | null;
    pathOverlapFn?: PathOverlapFn;
  },
): TaskCheckResult {
  const oob = options?.oob ?? null;
  const activeTasks = options?.activeTasks ?? null;
  const pathOverlapFn: PathOverlapFn = options?.pathOverlapFn ?? pathGlobsOverlapRef;

  // 本模块不直接用 testResults, 防止误读 worker 自报告 tests_green (等价 Python `del test_results`)。
  void testResults;

  const items: TaskCheckItem[] = [];
  items.push(checkTestsGreen(evalResult));
  items.push(checkDiffWithinAllowedPaths(oob));
  items.push(checkAllAcceptanceRefsHaveTests(task));
  items.push(checkNoEncroachingOtherActivePaths(task, activeTasks, pathOverlapFn));

  return mkResult(task.id, items);
}

/** tests_green 用 S4 机械求值的 eval_result.tests_green (§0.2)。 */
function checkTestsGreen(evalResult: TaskCheckEvalResult): TaskCheckItem {
  const ok = evalResult.tests_green;
  return mkItem(
    "tests_green",
    ok,
    ok ? "" : `task ${evalResult.task_id} 的 cases 求值未全绿`,
  );
}

/** 越界写检测。oob=null (actual_writes 不可用) → 软 pass with 降级说明。 */
function checkDiffWithinAllowedPaths(oob: OOBDetection | null): TaskCheckItem {
  if (oob === null) {
    return mkItem("diff_within_allowed_paths", true, "actual_writes 不可用, 此项降级软约束");
  }
  if (oob.is_oob) {
    return mkItem(
      "diff_within_allowed_paths",
      false,
      `越界写: ${pyList(oob.out_of_bounds)}`,
    );
  }
  return mkItem(
    "diff_within_allowed_paths",
    true,
    `all writes in ${pyList(oob.declared_paths)}`,
  );
}

/** 渲染字符串列表为近似 Python list repr `['a', 'b']` (测试只断言子串)。 */
function pyList(xs: readonly string[]): string {
  return `[${xs.map((x) => `'${x}'`).join(", ")}]`;
}

/**
 * task.acceptance_refs 非空且 task.tests 非空即 pass。
 *
 * 严格"AC → test case"映射在 plan_check 已查, 此处只兜底确保 task 自身不空。
 */
function checkAllAcceptanceRefsHaveTests(task: Task): TaskCheckItem {
  if (task.acceptance_refs.length === 0) {
    return mkItem(
      "all_acceptance_refs_have_tests",
      false,
      `task ${task.id} 的 acceptance_refs 为空`,
    );
  }
  if (task.tests.length === 0) {
    return mkItem(
      "all_acceptance_refs_have_tests",
      false,
      `task ${task.id} 无 test case`,
    );
  }
  return mkItem(
    "all_acceptance_refs_have_tests",
    true,
    `${task.tests.length} case(s) 覆盖 ${task.acceptance_refs.length} AC`,
  );
}

/**
 * task 没动到其它 active task 的 allowed_write_paths。
 *
 * 判定: 本 task 的 allowed_write_paths 与其它 active task 的 allowed_write_paths
 * 不重叠。注意此处不读 actual_writes, 只判声明路径冲突 (实际写入冲突在 §3.2 conflicts 算)。
 * activeTasks=null/空 时跳过 (软 pass)。
 */
function checkNoEncroachingOtherActivePaths(
  task: Task,
  activeTasks: Task[] | null,
  pathOverlapFn: PathOverlapFn,
): TaskCheckItem {
  if (!activeTasks || activeTasks.length === 0) {
    return mkItem(
      "no_encroaching_other_active_paths",
      true,
      "无其它 active task (或未传入)",
    );
  }

  const encroached: string[] = [];
  for (const other of activeTasks) {
    if (other.id === task.id) {
      continue;
    }
    if (pathOverlapFn(task.allowed_write_paths, other.allowed_write_paths)) {
      encroached.push(other.id);
    }
  }

  if (encroached.length > 0) {
    return mkItem(
      "no_encroaching_other_active_paths",
      false,
      `task ${task.id} 与 active task ${pyList(encroached)} 的写路径重叠`,
    );
  }
  return mkItem(
    "no_encroaching_other_active_paths",
    true,
    `task ${task.id} 与其它 active task 写路径不冲突`,
  );
}
