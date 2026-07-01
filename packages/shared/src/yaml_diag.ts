/**
 * YAML 解析诊断 helper (跨包共享)。
 *
 * 动机: plan-agent (LLM) 手写的 task-plan.yaml 里, 中文 scenario/title 值常含 `: `
 * (冒号+空格) 且未加引号 —— YAML 会把它误判为嵌套 mapping, js-yaml 抛 YAMLException。
 * 原始异常是不可读的堆栈, 主 agent / plan-agent 无从下手。本模块把它转成带
 * 【文件 / 行号 / 列号 / 冒号提示】的可执行诊断, 使整个循环从"不透明崩溃"变成"自愈"
 * (主 agent 读到提示即知该让 plan-agent 给某行加引号)。
 *
 * 三方复用: ssot-ts 的 readTaskPlan (CLI 止崩)、shared 的 hook (post_task_collect /
 * guard_anchors 的 deny 消息)、cli 的 doctor --run 预检。
 */
import * as yaml from "js-yaml";

/** js-yaml YAMLException 的鸭子判定所需的最小形状。 */
interface YamlMark {
  readonly line: number; // 0-based
  readonly column: number; // 0-based
}
interface YamlExceptionLike {
  readonly name: string;
  readonly reason?: string;
  readonly message?: string;
  readonly mark?: YamlMark;
}

/** err 是否为 js-yaml 的 YAMLException (含数值 mark.line)。 */
function isYamlException(err: unknown): err is YamlExceptionLike {
  if (err === null || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  if (e.name !== "YAMLException") return false;
  const mark = e.mark as Record<string, unknown> | undefined;
  return (
    typeof mark === "object" &&
    mark !== null &&
    typeof mark.line === "number"
  );
}

/**
 * 判断某行的 value 部分是否"含未加引号的冒号+空格"。
 *
 * 只处理最典型、也最坑的形态: `<缩进>[- ]<key>: <value>`, 其中 value 未以引号开头
 * 却又含 `: ` —— 这正是 `scenario: 负向: xxx` 这类。命中返回 true。
 * 注意: 冒号出现在 `#` 注释里不算 (YAML 忽略注释)。
 */
function lineHasUnquotedColon(line: string): boolean {
  // 提取第一个 `key: ` 之后的 value。key 允许前导缩进与可选的 `- ` 序列项标记。
  const m = line.match(/^\s*(?:-\s+)?[^:\s#][^:]*:\s+(.*)$/);
  if (m === null) return false;
  let value = m[1] ?? "";
  // 剥掉行尾注释 (简化处理: 未被引号包裹时, ` #` 起始视为注释)。
  const hashIdx = value.indexOf(" #");
  if (hashIdx !== -1) value = value.slice(0, hashIdx);
  value = value.trim();
  if (value === "") return false;
  // value 已被引号包裹 → 合法, 不提示。
  if (value.startsWith('"') || value.startsWith("'")) return false;
  // value 内仍含 `: ` (冒号+空格) → 就是未引用冒号的坑。
  return /:\s/.test(value);
}

/**
 * 把 YAML 解析异常转成可执行诊断字符串。
 *
 * - err 是 YAMLException → `<path> YAML 解析失败 (第 N 行第 M 列): <reason>`,
 *   若该行 value 含未加引号的冒号, 追加一行修复提示。
 * - 否则 → `<path> 解析失败: <message>` (原样透传, 不臆造冒号提示)。
 */
export function describeYamlError(
  sourcePath: string,
  text: string,
  err: unknown,
): string {
  if (!isYamlException(err)) {
    const msg = err instanceof Error ? err.message : String(err);
    return `${sourcePath} 解析失败: ${msg}`;
  }
  const line0 = err.mark!.line;
  const col0 = err.mark!.column;
  const line1 = line0 + 1;
  const col1 = col0 + 1;
  const reason = err.reason ?? err.message ?? "unknown";
  const offendingLine = text.split(/\r?\n/)[line0] ?? "";
  let out = `${sourcePath} YAML 解析失败 (第 ${line1} 行第 ${col1} 列): ${reason}`;
  if (lineHasUnquotedColon(offendingLine)) {
    out +=
      `\n  提示: 第 ${line1} 行的值含未加引号的冒号 (": "), YAML 会把它误判为嵌套映射。` +
      `请把整个值用引号包裹, 例如 scenario: "负向: ..."。`;
  }
  return out;
}

/** parseYamlSafe 的返回形状: 成功带 data, 失败带可读 message。 */
export type YamlParseResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly message: string };

/**
 * 安全解析 YAML 文本。
 *
 * 成功 → { ok: true, data }; 失败 → { ok: false, message }, message 已含
 * 文件 / 行号 / 列号 / 冒号提示 (见 describeYamlError)。调用方决定是抛出还是降级。
 */
export function parseYamlSafe(sourcePath: string, text: string): YamlParseResult {
  try {
    return { ok: true, data: yaml.load(text) };
  } catch (e) {
    return { ok: false, message: describeYamlError(sourcePath, text, e) };
  }
}
