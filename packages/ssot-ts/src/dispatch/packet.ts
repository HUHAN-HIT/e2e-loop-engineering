/**
 * 给 worker 的最小派发 packet (design §0.4 artifact-first, §prompts §D 输入 schema)。
 *
 * 行为权威: Python `loop_engineering/dispatch/packet.py`。
 * 规范源: design §0.4 —— coordinator 只把"最小必读切片"作为 context_paths 喂给 worker,
 * worker 自己定位相关段。依赖 task 的 summary.md 作为 dependency_artifacts (按需自读),
 * 不让 worker 拿到全局上下文 (隔离的 hallucination 边界)。
 *
 * 不依赖 WorkerRunner, 是纯数据。由 coordinator 用 buildPacket 构造, runner.dispatch 消费。
 *
 * 与 Python 的差异处理:
 * - dataclass(frozen=True) → readonly 接口 (TS 不强制冻结, 语义上视作只读)。
 * - pathlib.Path → 字符串路径 (本子包统一用 string 表示文件路径, 与 node:path 协作)。
 */
import * as path from "node:path";

import type { Task, TaskPlan, TestCase } from "../schema/task_plan.js";

/**
 * coordinator 派发给 worker 的最小 packet。
 *
 * worker 只看这个 + contextPaths, 不读全局上下文 (artifact-first, design §0.4)。
 */
export interface WorkerPacket {
  /** 当前 task 的 id。 */
  readonly task_id: string;
  /**
   * coordinator 切好的最小必读切片。若当前 task 有 detail_ref, detail 文件排第一。
   */
  readonly context_paths: string[];
  /** 当前 task detail 文件路径; 无 detail_ref 时为 null。 */
  readonly task_detail_path: string | null;
  /** 当前 task 是否按复杂度/风险策略要求 detail。 */
  readonly task_detail_required: boolean;
  /** 依赖 task 的 summary.md 路径列表, 按需自读。 */
  readonly dependency_artifacts: string[];
  /** task.tests (list[TestCase]), worker 写测试去满足这些 case。 */
  readonly planned_test_cases: TestCase[];
  /** task.allowed_write_paths, 越界会被 actual_writes 抓。 */
  readonly allowed_write_paths: string[];
  /** 多服务: 该 task 提供的契约 id。 */
  readonly provides_contracts: string[];
  /** 多服务: 该 task 消费的契约 id。 */
  readonly consumes_contracts: string[];
  /** 实际工作目录 (用于 actual_writes 采集的 fs snapshot / git diff 基线)。 */
  readonly workdir: string;
}

/**
 * 从 task + plan 构造 packet。
 *
 * @param task 要派发的 task。
 * @param plan 整个 TaskPlan (用于反查依赖 task, 不直接传 plan 给 worker)。
 * @param runDir run 根目录 (用于定位 tasks/<dep_id>/summary.md 与 task detail)。
 * @param options.designMd planning/design.md 路径, 作为 contextPaths 之一。
 * @param options.taskPlanYaml planning/task-plan.yaml 路径, 作为 contextPaths 之一。
 * @param options.workdir 实际代码工作目录 (默认 dirname(runDir) —— 假设代码在 runDir 之外)。
 */
export function buildPacket(
  task: Task,
  plan: TaskPlan,
  runDir: string,
  options: {
    designMd: string;
    taskPlanYaml: string;
    workdir?: string;
  },
): WorkerPacket {
  const designMd = options.designMd;
  const taskPlanYaml = options.taskPlanYaml;
  const workdir = options.workdir ?? path.dirname(runDir);
  const taskDetailRequired =
    plan.complexity === "complex" && (task.risk === "high" || task.exclusive);
  const runDirClean = runDir.replace(/[\\/]+$/, "");
  const taskDetailPath = task.detail_ref ? `${runDirClean}/${task.detail_ref}` : null;
  const contextPaths =
    taskDetailPath === null
      ? [designMd, taskPlanYaml]
      : [taskDetailPath, designMd, taskPlanYaml];

  // 只放依赖 task 的 summary.md (理论上 readyFrontier 已保证依赖 complete)。
  const byId = new Map<string, Task>();
  for (const t of plan.tasks) byId.set(t.id, t);

  const depArtifacts: string[] = [];
  for (const depId of task.depends_on) {
    const depTask = byId.get(depId);
    if (depTask === undefined) continue;
    depArtifacts.push(path.join(runDir, "tasks", depId, "summary.md"));
  }

  return {
    task_id: task.id,
    context_paths: contextPaths,
    task_detail_path: taskDetailPath,
    task_detail_required: taskDetailRequired,
    dependency_artifacts: depArtifacts,
    planned_test_cases: [...task.tests],
    allowed_write_paths: [...task.allowed_write_paths],
    provides_contracts: [...task.provides_contracts],
    consumes_contracts: [...task.consumes_contracts],
    workdir,
  };
}
