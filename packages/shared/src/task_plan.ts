/**
 * task-plan.yaml 类型与读取 (规范源: design §3.1 + §11.1, 与 Python `schema/task_plan.py` 对齐)。
 *
 * 只读不写 (TS 端在 hook 路径上只需要查询 active task 的 allowed_write_paths / acceptance_refs)。
 */

import * as yaml from "js-yaml";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Complexity } from "./run_state.js";

/** task.status 四态 (design §3.2) */
export type TaskStatus = "pending" | "running" | "blocked" | "complete";

/** task 风险等级 (design §3.1) */
export type RiskLevel = "normal" | "high";

/** 单个测试用例 (design §3.1); checks 是文法字符串, 不在 schema 层解析 */
export interface TestCase {
  id: string;
  scenario: string;
  checks: string[];
}

/** 单个 task (design §3.1 / §11.1) */
export interface Task {
  id: string;
  title: string;
  allowed_write_paths: string[];
  acceptance_refs: string[];
  depends_on?: string[];
  exclusive?: boolean;
  risk?: RiskLevel;
  tests?: TestCase[];
  status?: TaskStatus;
  attempt?: number;
  /** 多服务 run 可选 (design §11.1) */
  service?: string | null;
  provides_contracts?: string[];
  consumes_contracts?: string[];
}

/** task-plan.yaml 顶层模型 (design §3.1) */
export interface TaskPlan {
  schema: string; // 默认 "loop-engineering.task-plan.v2"
  complexity: Complexity;
  tasks: Task[];
}

const DEFAULT_SCHEMA = "loop-engineering.task-plan.v2";

/** 手写 type guard: 判定任意值是否是合法 TaskPlan (zod-free) */
export function isTaskPlan(value: unknown): value is TaskPlan {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.schema !== "undefined" && typeof v.schema !== "string")
    return false;
  if (typeof v.complexity !== "string") return false;
  if (!Array.isArray(v.tasks)) return false;
  for (const t of v.tasks as unknown[]) {
    if (typeof t !== "object" || t === null) return false;
    const tk = t as Record<string, unknown>;
    if (typeof tk.id !== "string") return false;
    if (typeof tk.title !== "string") return false;
    if (!Array.isArray(tk.allowed_write_paths)) return false;
    if (!Array.isArray(tk.acceptance_refs)) return false;
  }
  return true;
}

/**
 * 从 runDir 读取 task-plan.yaml。
 *
 * 约定路径: `<runDir>/planning/task-plan.yaml` (design §6)。
 * 文件不存在 / 解析失败 / 结构非法时返回 null (hook 路径上不抛, 由调用方降级)。
 */
export function readTaskPlan(runDir: string): TaskPlan | null {
  const planPath = path.join(runDir, "planning", "task-plan.yaml");
  let text: string;
  try {
    text = fs.readFileSync(planPath, "utf-8");
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = yaml.load(text);
  } catch {
    return null;
  }
  if (!isTaskPlan(data)) return null;
  // schema 字段补默认
  if (data.schema === undefined) {
    return { ...data, schema: DEFAULT_SCHEMA };
  }
  return data;
}

/** 在 plan 内按 id 查 task; 找不到返回 null */
export function findTaskById(plan: TaskPlan, taskId: string): Task | null {
  for (const t of plan.tasks) {
    if (t.id === taskId) return t;
  }
  return null;
}
