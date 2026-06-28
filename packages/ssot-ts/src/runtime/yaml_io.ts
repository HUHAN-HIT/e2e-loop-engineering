/**
 * task-plan.yaml 的 YAML 序列化 / 反序列化 (对齐 Python `TaskPlan.to_yaml_file` /
 * `from_yaml_file`)。
 *
 * 行为权威: Python `schema/task_plan.py` 的 `model_dump(by_alias=True, exclude_none=False,
 * mode="json")` + `yaml.safe_dump(sort_keys=False, allow_unicode=True)`。
 *
 * 关键对齐点:
 * - 真实键是 `schema` (Python 用 alias="schema"; TS zod 直接用 `schema`)。
 * - exclude_none=False: 保留 null 字段 (如 task.service: null), 不剔除。
 * - sort_keys=False: 字段按声明顺序输出 (本模块显式按 Python 模型字段顺序构造 plain dict)。
 *
 * 反序列化: js-yaml load → zod parse (在 directory.ts 内做 parse, 本模块只负责 load 文本)。
 */
import * as yaml from "js-yaml";

import type { KeyDiffsFile } from "../schema/artifacts.js";
import { parseTaskPlan } from "../schema/task_plan.js";
import type { Task, TaskPlan, TestCase } from "../schema/task_plan.js";

/** 把单个 TestCase 转为按声明顺序的 plain object (id / scenario / checks)。 */
function dumpTestCase(tc: TestCase): Record<string, unknown> {
  return {
    id: tc.id,
    scenario: tc.scenario,
    checks: [...tc.checks],
  };
}

/**
 * 把单个 Task 转为按声明顺序的 plain object (对齐 Python Task 字段顺序)。
 *
 * 字段顺序与 schema/task_plan.py Task 一致:
 * id, title, allowed_write_paths, acceptance_refs, depends_on, exclusive, risk,
 * tests, status, attempt, service, provides_contracts, consumes_contracts。
 * service=null 保留 (exclude_none=False)。
 */
function dumpTask(t: Task): Record<string, unknown> {
  return {
    id: t.id,
    title: t.title,
    allowed_write_paths: [...t.allowed_write_paths],
    acceptance_refs: [...t.acceptance_refs],
    depends_on: [...t.depends_on],
    exclusive: t.exclusive,
    risk: t.risk,
    tests: t.tests.map(dumpTestCase),
    status: t.status,
    attempt: t.attempt,
    service: t.service ?? null,
    provides_contracts: [...t.provides_contracts],
    consumes_contracts: [...t.consumes_contracts],
  };
}

/**
 * 把 TaskPlan 序列化为 YAML 文本 (对齐 Python to_yaml_file)。
 *
 * 先经 zod 解析补默认值 (schema 默认值 / 列表默认 [] / 枚举默认), 再按声明顺序构造
 * plain dict, 最后 yaml.dump(sortKeys=false)。
 */
export function dumpTaskPlanYaml(plan: TaskPlan): string {
  const validated = parseTaskPlan(plan);
  const data = {
    schema: validated.schema,
    complexity: validated.complexity,
    tasks: validated.tasks.map(dumpTask),
  };
  return yaml.dump(data, { sortKeys: false, lineWidth: -1 });
}

/** 读 YAML 文本 → 原始数据 (校验交给 directory.ts 的 parseTaskPlan)。 */
export function loadTaskPlanYaml(text: string): unknown {
  return yaml.load(text);
}

/**
 * 把 KeyDiffsFile 序列化为 YAML 文本 (对齐 Python `KeyDiffsFile.to_yaml_file`)。
 *
 * 字段顺序: schema, task_id, key_diffs (每条 file/change/why/risk)。sort_keys=False。
 */
export function dumpKeyDiffsYaml(file: KeyDiffsFile): string {
  const data = {
    schema: file.schema,
    task_id: file.task_id,
    key_diffs: file.key_diffs.map((kd) => ({
      file: kd.file,
      change: kd.change,
      why: kd.why,
      risk: kd.risk,
    })),
  };
  return yaml.dump(data, { sortKeys: false, lineWidth: -1 });
}
