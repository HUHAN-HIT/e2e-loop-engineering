/**
 * task-plan.yaml 类型与读取 (规范源: design §3.1 + §11.1, 与 Python `schema/task_plan.py` 对齐)。
 *
 * 只读不写 (TS 端在 hook 路径上只需要查询 active task 的 allowed_write_paths / acceptance_refs)。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Complexity } from "./run_state.js";
import { parseYamlSafe } from "./yaml_diag.js";

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
  /** 当前 task 的长篇指导文件路径, 相对 run root。 */
  detail_ref?: string | null;
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
 * 读 task-plan.yaml 的诊断结果 (区分四种情形, 供 hook 给出精确 deny 消息)。
 *
 * - "ok": 解析成功且结构合法
 * - "missing": 文件不存在 (尚未产出计划 —— 合法中间态)
 * - "parse_error": YAML 语法错误 (message 已含文件/行号/冒号提示)
 * - "invalid": YAML 解析成功但结构不满足 TaskPlan (缺 tasks / 字段类型错)
 */
export type TaskPlanRead =
  | { status: "ok"; plan: TaskPlan }
  | { status: "missing" }
  | { status: "parse_error"; message: string }
  | { status: "invalid" };

/**
 * 从 runDir 读取 task-plan.yaml 并给出诊断。
 *
 * 关键动机: 老 `readTaskPlan` 把"文件不存在""YAML 语法错""结构非法"一律压成 null,
 * hook 无法区分 —— plan-agent 产出的坏 YAML 会被误报成"计划缺失", 诊断毫无指向。
 * 本函数把三者分开, "parse_error" 携带 describeYamlError 生成的行号+冒号修复提示,
 * 主 agent 据此可精确指挥 plan-agent 给某行加引号 (自愈)。
 */
export function readTaskPlanDiag(runDir: string): TaskPlanRead {
  const planPath = path.join(runDir, "planning", "task-plan.yaml");
  let text: string;
  try {
    text = fs.readFileSync(planPath, "utf-8");
  } catch {
    return { status: "missing" };
  }
  const res = parseYamlSafe(planPath, text);
  if (!res.ok) return { status: "parse_error", message: res.message };
  if (!isTaskPlan(res.data)) return { status: "invalid" };
  const data = res.data;
  // schema 字段补默认
  const plan = data.schema === undefined ? { ...data, schema: DEFAULT_SCHEMA } : data;
  return { status: "ok", plan };
}

/**
 * 从 runDir 读取 task-plan.yaml (兼容旧签名)。
 *
 * 约定路径: `<runDir>/planning/task-plan.yaml` (design §6)。
 * 文件不存在 / 解析失败 / 结构非法时返回 null (hook 路径上不抛, 由调用方降级)。
 * 需要区分失败原因时改用 {@link readTaskPlanDiag}。
 */
export function readTaskPlan(runDir: string): TaskPlan | null {
  const r = readTaskPlanDiag(runDir);
  return r.status === "ok" ? r.plan : null;
}

/** 在 plan 内按 id 查 task; 找不到返回 null */
export function findTaskById(plan: TaskPlan, taskId: string): Task | null {
  for (const t of plan.tasks) {
    if (t.id === taskId) return t;
  }
  return null;
}
