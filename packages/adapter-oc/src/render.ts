/**
 * OpenCode adapter 的渲染工具。
 *
 * 职责:
 * - 把 CC 形态的 subagent (`core/subagents/<id>.md`, frontmatter 含 name/description/tools)
 *   转换为 OpenCode 形态的 agent (`.opencode/agents/<id>.md`, frontmatter 含
 *   description/mode/permission)。
 * - 生成 / 深合并 `.opencode/opencode.json`。
 *
 * OpenCode 官方约定 (opencode.ai/docs):
 * - Agent 从 `.opencode/agents/<name>.md` 读 (复数 agents); 文件名即 agent 名, 不需要 name 字段。
 * - frontmatter 用 description(必) / mode(primary|subagent|all) / permission(map); 不用已废弃的 tools。
 * - opencode.json 的 `permission.skill` 门控 skill 工具 ("allow"|"ask"|"deny")。
 *
 * 设计取舍:
 * - frontmatter 序列化统一用 js-yaml (shared 已依赖), 保证引号/转义稳定。
 * - 正文 (--- 之后) 原样保留, P2 不做中性化 (CC 专属措辞如 "Task 工具" 留待 P3)。
 */

import yaml from "js-yaml";

/** OpenCode permission map 取值。 */
type OcPermission = "allow" | "deny";

/**
 * CC tools 列表 → OpenCode permission map。
 *
 * 映射规则 (任务规格):
 *   read  ← tools 含 Read
 *   edit  ← tools 含 Write 或 Edit
 *   glob  ← tools 含 Glob
 *   grep  ← tools 含 Grep
 *   bash  ← tools 含 Bash
 *   task  ← tools 含 Task
 * 命中 → "allow"; 否则 → "deny"。
 */
function toolsToPermission(tools: string[]): Record<string, OcPermission> {
  const has = (name: string): boolean =>
    tools.some((t) => t.trim().toLowerCase() === name.toLowerCase());
  const allow = (cond: boolean): OcPermission => (cond ? "allow" : "deny");
  return {
    read: allow(has("Read")),
    edit: allow(has("Write") || has("Edit")),
    glob: allow(has("Glob")),
    grep: allow(has("Grep")),
    bash: allow(has("Bash")),
    task: allow(has("Task")),
  };
}

/**
 * 把 markdown 文本拆成 frontmatter (YAML 文本) 与正文。
 * 约定: 文件以 `---\n<yaml>\n---\n<body>` 开头。无 frontmatter 时 fm 为空对象, body 为全文。
 */
function splitFrontmatter(text: string): { fm: string; body: string } {
  // 兼容 CRLF: 统一按行处理
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { fm: "", body: text };
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) {
    // 只有起始 ---, 无闭合: 当作无 frontmatter, 原样返回
    return { fm: "", body: text };
  }
  const fm = normalized.slice(4, end);
  const body = normalized.slice(end + "\n---\n".length);
  return { fm, body };
}

/** CC subagent frontmatter 的关心字段。 */
interface CcAgentFrontmatter {
  name?: string;
  description?: string;
  tools?: string | string[];
}

/** 把 tools 字段归一为字符串数组 (兼容 "Read, Write" 与 ["Read","Write"])。 */
function normalizeTools(tools: string | string[] | undefined): string[] {
  if (Array.isArray(tools)) return tools.map((t) => String(t).trim()).filter(Boolean);
  if (typeof tools === "string") {
    return tools
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * 渲染单个 OpenCode agent 文件内容。
 *
 * @param ccMarkdown core/subagents/<id>.md 的全文 (frontmatter + 正文)
 * @returns OpenCode 形态的 markdown (frontmatter: description/mode/permission + 原正文)
 */
export function renderOpencodeAgent(ccMarkdown: string): string {
  const { fm, body } = splitFrontmatter(ccMarkdown);
  let parsed: CcAgentFrontmatter = {};
  if (fm.trim().length > 0) {
    const obj = yaml.load(fm);
    if (obj && typeof obj === "object") {
      parsed = obj as CcAgentFrontmatter;
    }
  }

  const description = String(parsed.description ?? "").trim();
  const permission = toolsToPermission(normalizeTools(parsed.tools));

  // OpenCode frontmatter: description(必) / mode / permission。文件名即 agent 名, 不带 name。
  const ocFm = {
    description,
    mode: "subagent",
    permission,
  };

  // js-yaml 序列化: lineWidth=-1 避免长 description 被折行 (OpenCode 解析更稳)。
  const fmText = yaml.dump(ocFm, { lineWidth: -1, noRefs: true }).trimEnd();

  // 正文原样保留 (含可能的 CC 专属措辞, P2 不中性化)。
  return `---\n${fmText}\n---\n${body}`;
}

/** OpenCode 配置文件的 schema URL。 */
const OPENCODE_SCHEMA = "https://opencode.ai/config.json";

/**
 * 生成全新的 opencode.json 内容 (不存在时使用)。
 * 默认放行 skill 工具 (permission.skill = "allow")。
 */
export function defaultOpencodeConfig(): Record<string, unknown> {
  return {
    $schema: OPENCODE_SCHEMA,
    permission: { skill: "allow" },
  };
}

/**
 * 把本工具需要的配置深合并进用户已有的 opencode.json。
 *
 * 合并语义 (任务规格, 镜像 adapter-cc installSettings 的健壮性):
 * - 保留用户所有字段不动。
 * - 仅确保 permission.skill 存在: 用户未设 → 补 "allow"; 用户已设 → 不覆盖用户值。
 *
 * @returns 合并后的对象 (不修改入参)。
 */
export function mergeOpencodeConfig(
  existing: Record<string, unknown>,
): Record<string, unknown> {
  // 深拷贝, 不动入参
  const merged = JSON.parse(JSON.stringify(existing)) as Record<string, unknown>;

  const perm = merged.permission;
  if (typeof perm !== "object" || perm === null || Array.isArray(perm)) {
    // permission 缺失或非对象: 设为含 skill:allow 的对象 (不丢用户其它顶层字段)
    merged.permission = { skill: "allow" };
    return merged;
  }
  const permObj = perm as Record<string, unknown>;
  if (!("skill" in permObj)) {
    permObj.skill = "allow";
  }
  // 已有 skill 值则保留用户设置
  return merged;
}
