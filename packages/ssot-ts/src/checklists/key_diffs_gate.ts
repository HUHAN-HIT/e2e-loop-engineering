/**
 * key-diffs.yaml 硬 gate (design §2.3) —— TS 版, 等价 Python
 * `loop_engineering/checklists/key_diffs_gate.py`。
 *
 * §2.3: risk:high 或 exclusive:true 的 task, 收口前 key-diffs.yaml 必须
 * 存在、可解析、且 key_diffs 非空 —— 机制硬 gate。其它 task 是软约束
 * (文件可选, 不强制)。
 *
 * 调用方 (收口阶段) 用 validateMany + allHardGatesPass 检验:
 * 任一硬 gate task FAIL 则整体不能进 COMPLETE。
 *
 * 与 Python 的差异处理:
 * - StrEnum GateStatus → const 对象 + 字符串字面量联合类型 (值即字符串, 等价)。
 * - dataclass(frozen=True) → readonly 接口。
 * - KeyDiffsFile.is_meaningful() 实例方法 → schema 子包的独立函数 isMeaningful(file)。
 * - f"{x!r}" repr → pyRepr (字符串加单引号), 测试只断言关键子串。
 */
import { isMeaningful } from "../schema/artifacts.js";
import type { KeyDiffsFile } from "../schema/artifacts.js";
import { RiskLevel } from "../schema/task_plan.js";
import type { Task } from "../schema/task_plan.js";

/** gate 校验结果三态 (StrEnum 等价: 值即字符串)。 */
export const GateStatus = {
  PASS: "pass", // 硬 gate 通过 / 普通 task 自愿提交且非空
  FAIL: "fail", // 硬 gate 失败 (缺文件 / 空 / 解析失败)
  SOFT: "soft", // 软约束未满足 (普通 task 缺 key-diffs.yaml), 不阻断
} as const;
export type GateStatus = (typeof GateStatus)[keyof typeof GateStatus];

/** 单个 task 的 key-diffs gate 校验结果。 */
export interface KeyDiffsGateResult {
  readonly task_id: string;
  readonly status: GateStatus;
  readonly reason: string;
}

/** 把值渲染成近似 Python `repr` (字符串加单引号), 用于诊断信息回显。 */
function pyRepr(v: unknown): string {
  if (typeof v === "string") {
    return `'${v}'`;
  }
  return String(v);
}

/**
 * 该 task 是否触发 key-diffs 硬 gate。
 *
 * design §2.3: risk==high 或 exclusive==True -> 硬 gate。
 */
export function isHardGateTask(task: Task): boolean {
  return task.risk === RiskLevel.high || Boolean(task.exclusive);
}

/**
 * 校验单个 task 的 key-diffs 提交。
 *
 * @param task 计划中的 task。
 * @param keyDiffs 已解析的 KeyDiffsFile (若 null/undefined 表示文件缺失或解析失败)。
 * @param rawYamlText 调用方可传入原始 YAML 文本用于诊断 (例如解析失败时回显)。
 *   本函数本身不重新解析 YAML (调用方负责 try/catch); 此参数仅用于错误信息富化, 可省略。
 */
export function validateKeyDiffsSubmission(
  task: Task,
  keyDiffs: KeyDiffsFile | null | undefined,
  options?: { rawYamlText?: string | null },
): KeyDiffsGateResult {
  const rawYamlText = options?.rawYamlText ?? null;
  const hard = isHardGateTask(task);

  if (hard) {
    if (keyDiffs === null || keyDiffs === undefined) {
      const tail = rawYamlText
        ? ` (raw_yaml_text 前 80 字符: ${pyRepr(rawYamlText.slice(0, 80))})`
        : "";
      return {
        task_id: task.id,
        status: GateStatus.FAIL,
        reason: `硬 gate task 缺 key-diffs.yaml 或解析失败${tail}`,
      };
    }
    if (!isMeaningful(keyDiffs)) {
      return {
        task_id: task.id,
        status: GateStatus.FAIL,
        reason: "硬 gate task 的 key_diffs 为空 (must be 非空)",
      };
    }
    return {
      task_id: task.id,
      status: GateStatus.PASS,
      reason: `硬 gate 通过: ${keyDiffs.key_diffs.length} 条 key diff`,
    };
  }

  // 普通 task —— 软约束
  if (keyDiffs === null || keyDiffs === undefined || !isMeaningful(keyDiffs)) {
    return {
      task_id: task.id,
      status: GateStatus.SOFT,
      reason: "普通 task, key-diffs.yaml 可省 (软约束)",
    };
  }
  return {
    task_id: task.id,
    status: GateStatus.PASS,
    reason: `普通 task 自愿提交: ${keyDiffs.key_diffs.length} 条 key diff`,
  };
}

/**
 * 批量校验: 每 task 一条结果。
 *
 * @param tasks 计划中的全部 task。
 * @param keyDiffsByTask task_id -> KeyDiffsFile | null。
 * @returns 与 tasks 一一对应的 KeyDiffsGateResult 列表。
 */
export function validateMany(
  tasks: readonly Task[],
  keyDiffsByTask: Record<string, KeyDiffsFile | null | undefined> | Map<string, KeyDiffsFile | null | undefined>,
): KeyDiffsGateResult[] {
  const getKd = (id: string): KeyDiffsFile | null | undefined =>
    keyDiffsByTask instanceof Map ? keyDiffsByTask.get(id) : keyDiffsByTask[id];

  const results: KeyDiffsGateResult[] = [];
  for (const t of tasks) {
    results.push(validateKeyDiffsSubmission(t, getKd(t.id)));
  }
  return results;
}

/**
 * 是否所有硬 gate task 都 PASS。
 *
 * 用于收口阶段: 任一 FAIL status 的硬 gate task 存在 -> 不能进 COMPLETE。
 * SOFT 状态 (普通 task 缺文件) 不阻断。
 */
export function allHardGatesPass(results: readonly KeyDiffsGateResult[]): boolean {
  return results.every((r) => r.status !== GateStatus.FAIL);
}
