/**
 * checks 文法求值器 (TS 版, 等价 Python `loop_engineering/checklists/checks_eval.py`)。
 *
 * 规范源: design §3.1。
 *
 * 文法白名单: 仅允许 `<lhs> <op> <rhs>`:
 * - lhs  : case 输出 schema 固定字段路径 (无引号标识符, 如 `passed`、`blocked_reasons`)
 * - op   : {==, !=, in, not in, <, <=, >, >=}
 * - rhs  : 字面量 (bool / int / float / 单/双引号字符串 / 方括号数组)
 *
 * 不允许函数调用、表达式嵌套、自然语言。手写递归下降解析, 不引解析器库。
 *
 * case 输出 schema 严格固定为 {id, passed: bool, failure_reason: str} (§3.1)。
 * coordinator 求值时只认这三字段; 遇未知字段路径 -> 判该 check 失败 + 告警。
 *
 * `in` / `not in` 语义方向 (design §3.1 示例 `'<scalar>' in <array-field>`):
 * - 字段值是**数组**时, rhs 是 scalar, 检查 "rhs ∈ field 值" (成员判定)。
 *   即 lhs 仍是字段路径, op 是 `in`, rhs 是 scalar, 求值时把 field 值视作集合。
 * - 字段值是**字符串**且 rhs 是字符串时, 走**子串**语义: `in` = rhs 是 lhs 值的子串,
 *   `not in` = 取反。三字段 schema ({id,passed,failure_reason}) 下 failure_reason 是 string,
 *   `'captcha' in failure_reason` 这类负路径断言依赖此语义 (方向 B: 领域断言落到 case.passed,
 *   checks 只断言 passed/failure_reason)。
 * - 其它类型组合 (如 rhs 非 string 却对 string 字段用 in) → 保持类型错误行为, 不 coerce。
 *
 * 与 Python 的差异处理:
 * - Python `int` / `float` 区分 → TS 统一 `number` (相等/比较语义对测试用例等价)。
 * - Python `isinstance(v, bool)` 排除 → TS `typeof v === "boolean"`; JS 布尔本就不是 number,
 *   故 `_is_number` 直接 `typeof v === "number"` 即可 (不必像 Python 排除 bool 子类)。
 * - Python `str.isalpha()/isalnum()` (Unicode) → 此处用 ASCII 判定; 文法字段路径与裸词
 *   在 design §3.1 中均为 ASCII 标识符, 行为对所有合法用例等价, 且非 ASCII 裸词照样落到
 *   "非法字符开头" 分支被拒, 不放宽白名单。
 * - dataclass(frozen=True) → 纯对象 (TS 不强制冻结, 语义上视作只读)。
 */
import type { TestCaseResult, TestResults } from "../schema/artifacts.js";
import type { TestCase } from "../schema/task_plan.js";

/**
 * check 文法解析失败。
 *
 * raw: 原始 check 字符串 (回显)。
 * reason: 诊断信息。
 */
export class CheckParseError extends Error {
  readonly raw: string;
  readonly reason: string;

  constructor(raw: string, reason: string) {
    super(`check parse error: ${reason} (raw=${pyRepr(raw)})`);
    this.name = "CheckParseError";
    this.raw = raw;
    this.reason = reason;
    Object.setPrototypeOf(this, CheckParseError.prototype);
  }
}

/** check 比较操作符白名单 (StrEnum 等价: 值即字符串)。 */
export const Op = {
  EQ: "==",
  NE: "!=",
  IN: "in",
  NOT_IN: "not in",
  LT: "<",
  LE: "<=",
  GT: ">",
  GE: ">=",
} as const;
export type Op = (typeof Op)[keyof typeof Op];

/** Op 全部取值 (等价 Python `[o.value for o in Op]`, 用于错误信息)。 */
const OP_VALUES: readonly Op[] = [
  Op.EQ,
  Op.NE,
  Op.IN,
  Op.NOT_IN,
  Op.LT,
  Op.LE,
  Op.GT,
  Op.GE,
];

/**
 * 操作符按"最长优先"排序, 避免把 `not in` 误识别成 `in` / `not`。
 * 解析时按此顺序扫描前缀匹配。
 */
const OPS_BY_LENGTH: readonly Op[] = [
  Op.NOT_IN, // "not in" 6 字符, 最长
  Op.EQ, // "=="
  Op.NE, // "!="
  Op.LE, // "<="
  Op.GE, // ">="
  Op.LT, // "<"
  Op.GT, // ">"
  Op.IN, // "in"
];

/** 解析后的 check: lhs op rhs。 */
export interface Check {
  readonly raw: string;
  readonly lhs: string;
  readonly op: Op;
  readonly rhs: unknown;
}

/** 单条 check 求值结果。 */
export interface CheckEvalResult {
  readonly check: Check;
  readonly passed: boolean;
  readonly error: string | null;
}

/** 单个 test case 的全部 checks 求值结果。 */
export interface CaseEvalResult {
  readonly case_id: string;
  readonly check_results: CheckEvalResult[];
  /** case 通过 = 至少有一条 check 且全部通过。 */
  readonly passed: boolean;
}

/** 单个 task 全部 case 的求值汇总。 */
export interface TaskCheckEvalResult {
  readonly task_id: string;
  readonly case_results: CaseEvalResult[];
  readonly warnings: string[];
  /** task 测试全绿 = 至少有一个 case 且全部通过。 */
  readonly tests_green: boolean;
}

// ---------------------------------------------------------------------------
// 字符分类辅助 (ASCII, 对齐文法白名单)
// ---------------------------------------------------------------------------

/** ASCII 字母。 */
function isAlpha(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
}

/** ASCII 数字。 */
function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

/** ASCII 字母或数字。 */
function isAlnum(c: string): boolean {
  return isAlpha(c) || isDigit(c);
}

/**
 * 把值渲染成近似 Python `repr` 的形式 (字符串加单引号), 用于错误信息回显,
 * 与 Python 端 `{x!r}` 行为对齐 (测试只断言关键字, 不强依赖精确格式)。
 */
function pyRepr(v: unknown): string {
  if (typeof v === "string") {
    return `'${v}'`;
  }
  return String(v);
}

// ---------------------------------------------------------------------------
// parse_check —— 手写递归下降解析
// ---------------------------------------------------------------------------

/** 跳过空白 (空格 / tab)。 */
function skipWs(s: string, i: number): number {
  while (i < s.length && (s[i] === " " || s[i] === "\t")) {
    i += 1;
  }
  return i;
}

/**
 * 解析 lhs 字段路径标识符。
 *
 * 支持 `a.b.c` 风格 (设计上预留 JSONPath 子集), 但当前 schema 固定字段
 * 都是单段 (`passed`, `failure_reason`), 故仅允许字母数字 + 下划线 + 点。
 * 不允许前导数字 (避免与数字字面量混淆)。
 */
function parseIdentifier(s: string, i: number): [string, number] {
  const start = i;
  if (i >= s.length || !(isAlpha(s[i]!) || s[i] === "_")) {
    throw new CheckParseError(s, `位置 ${i}: 字段路径必须以字母/下划线开头`);
  }
  while (i < s.length && (isAlnum(s[i]!) || s[i] === "." || s[i] === "_")) {
    i += 1;
  }
  return [s.slice(start, i), i];
}

/** 解析单/双引号字符串, 不支持转义 (文法刻意极简)。 */
function parseQuotedString(s: string, i: number): [string, number] {
  const quote = s[i]!;
  // 内部不变量: 入口必为引号 (调用方已判定)。
  let j = i + 1;
  const buf: string[] = [];
  while (j < s.length) {
    const c = s[j]!;
    if (c === quote) {
      return [buf.join(""), j + 1];
    }
    buf.push(c);
    j += 1;
  }
  throw new CheckParseError(s, `位置 ${i}: 字符串引号未闭合 (到末尾仍未找到匹配的 ${quote})`);
}

/**
 * 解析方括号数组 `[a, b, c]`。
 *
 * 元素按"裸标识符或字面量"解析, 每个元素都被解释成"字符串或数字或 bool"。
 * design §3.1: 数组元素字面量规则与顶层 rhs 一致。
 */
function parseArray(s: string, i: number): [unknown[], number] {
  // 内部不变量: s[i] === "[" (调用方已判定)。
  let j = i + 1;
  const items: unknown[] = [];
  for (;;) {
    j = skipWs(s, j);
    if (j >= s.length) {
      throw new CheckParseError(s, `位置 ${i}: 数组未闭合 (到末尾仍未找到 ])`);
    }
    if (s[j] === "]") {
      return [items, j + 1];
    }
    // 解析单个元素 (数组内裸词按字符串)
    let item: unknown;
    [item, j] = parseLiteralInner(s, j, true);
    items.push(item);
    j = skipWs(s, j);
    if (j >= s.length) {
      throw new CheckParseError(s, `位置 ${i}: 数组未闭合 (元素后到末尾)`);
    }
    if (s[j] === ",") {
      j += 1;
      continue;
    }
    if (s[j] === "]") {
      return [items, j + 1];
    }
    throw new CheckParseError(
      s,
      `位置 ${j}: 数组元素后必须跟 ',' 或 ']', 实际为 ${pyRepr(s[j])}`,
    );
  }
}

/**
 * 解析标量字面量 (字符串 / 数字 / bool / 数组)。
 *
 * 顶层 rhs 位置不允许裸标识符 (除 true/false/null) —— 防止 worker 用裸词伪装
 * 字段引用 (§3.1)。但数组 `[a, b]` 内部裸词按字符串字面量解析。
 */
function parseScalarLiteral(s: string, i: number): [unknown, number] {
  return parseLiteralInner(s, i, false);
}

/** 标量字面量解析核心。inArray=true 时裸词视作字符串。 */
function parseLiteralInner(s: string, i: number, inArray: boolean): [unknown, number] {
  i = skipWs(s, i);
  if (i >= s.length) {
    throw new CheckParseError(s, `位置 ${i}: 期望字面量但到末尾`);
  }
  const c = s[i]!;
  // 引号字符串
  if (c === "'" || c === '"') {
    return parseQuotedString(s, i);
  }
  // 数组
  if (c === "[") {
    // 数组内嵌套数组按非法处理 (不允许嵌套) —— parseArray 已隐式保证
    return parseArray(s, i);
  }
  // 数字 (含负号)
  if (c === "-" || isDigit(c)) {
    return parseNumber(s, i);
  }
  // 裸词
  if (isAlpha(c) || c === "_") {
    const [word, end] = parseBareWord(s, i);
    const low = word.toLowerCase();
    if (low === "true") {
      return [true, end];
    }
    if (low === "false") {
      return [false, end];
    }
    if (low === "null" || low === "none") {
      return [null, end];
    }
    if (inArray) {
      // 数组内: 裸词按字符串字面量
      return [word, end];
    }
    // 顶层 rhs: 拒绝裸词 (要求加引号; 防止 worker 用裸标识符伪装字段引用)
    throw new CheckParseError(
      s,
      `位置 ${i}: rhs 裸词 ${pyRepr(word)} 不合法 (仅允许 true/false/null); ` +
        `若为字符串字面量请加引号`,
    );
  }
  throw new CheckParseError(s, `位置 ${i}: 字面量以非法字符 ${pyRepr(c)} 开头`);
}

/** 解析整数或浮点 (无科学记数法, 极简)。 */
function parseNumber(s: string, i: number): [number, number] {
  const start = i;
  if (s[i] === "-") {
    i += 1;
  }
  let seenDot = false;
  while (i < s.length && (isDigit(s[i]!) || s[i] === ".")) {
    if (s[i] === ".") {
      if (seenDot) {
        throw new CheckParseError(s, `位置 ${i}: 数字含多个小数点`);
      }
      seenDot = true;
    }
    i += 1;
  }
  const token = s.slice(start, i);
  if (token === "" || token === "-") {
    throw new CheckParseError(s, `位置 ${start}: 数字字面量不完整`);
  }
  const value = Number(token);
  if (Number.isNaN(value)) {
    throw new CheckParseError(s, `位置 ${start}: 无法解析数字 ${pyRepr(token)}`);
  }
  return [value, i];
}

/** 解析裸词 (字母/下划线/数字), 不解释其语义。 */
function parseBareWord(s: string, i: number): [string, number] {
  const start = i;
  while (i < s.length && (isAlnum(s[i]!) || s[i] === "_")) {
    i += 1;
  }
  return [s.slice(start, i), i];
}

/**
 * 从 start 位置向右扫描第一个出现的合法 op。
 *
 * 策略: 在每个候选分割点按 OPS_BY_LENGTH (长 op 优先) 做前缀匹配。
 * 要求 op 前后都是空白 (避免把 `index` 里的 `in` 误识别)。
 */
function findOp(s: string, start: number): [Op, number] | null {
  const n = s.length;
  let i = start;
  while (i < n) {
    // op 必须前后是空白 (或字符串边界)。lhs 已被解析到 i 之前。
    // 这里 i 是 op 起点候选。
    for (const op of OPS_BY_LENGTH) {
      const opStr = op as string;
      const end = i + opStr.length;
      if (end > n) {
        continue;
      }
      if (s.slice(i, end) !== opStr) {
        continue;
      }
      // 前导必须是空白 (或边界)
      if (i > start && s[i - 1] !== " " && s[i - 1] !== "\t") {
        continue;
      }
      // 后继: in / not in 后面必须跟空白; 二元符号 ==/!=/</... 后面也要求空白或 rhs 边界
      if (end < n && s[end] !== " " && s[end] !== "\t") {
        continue;
      }
      return [op, i];
    }
    i += 1;
  }
  return null;
}

/**
 * 解析单条 check 字符串 -> Check。
 *
 * 支持两种语法顺序 (design §3.1 示例驱动):
 *     1. `<field> <op> <literal>`   —— 通用形式 (==, !=, <, <=, >, >= 等)
 *     2. `<literal> in <field>`      —— `in` / `not in` 的惯用写法
 *        (design 示例: `'clarification_not_approved' in blocked_reasons`)
 *
 * 求值时 lhs 永远规范化为字段路径, rhs 永远规范化为字面量。
 *
 * @throws CheckParseError 任何文法违规 (函数调用、嵌套、未闭合引号、未知 op 等)。
 */
export function parseCheck(raw: unknown): Check {
  if (typeof raw !== "string") {
    throw new CheckParseError(String(raw), "check 必须是字符串");
  }
  const s = raw.trim();
  if (!s) {
    throw new CheckParseError(raw, "check 为空字符串");
  }

  // 拒绝嵌套括号 / 函数调用 (在解析前用结构检查兜底)
  if (s.includes("(") || s.includes(")")) {
    throw new CheckParseError(raw, "不允许括号 (含函数调用 / 嵌套表达式)");
  }
  if (s.includes("{") || s.includes("}")) {
    throw new CheckParseError(raw, "不允许花括号");
  }

  let i = skipWs(s, 0);
  if (i >= s.length) {
    throw new CheckParseError(raw, "check 缺少 lhs");
  }

  const firstChar = s[i]!;
  const lhsIsLiteral =
    firstChar === "'" ||
    firstChar === '"' ||
    isDigit(firstChar) ||
    firstChar === "-" ||
    firstChar === "[";

  // 路径 A: lhs 是字面量 -> op 必须是 in / not in, rhs 必须是字段路径
  if (lhsIsLiteral) {
    let lhsLiteral: unknown;
    let j: number;
    [lhsLiteral, j] = parseScalarLiteral(s, i);
    j = skipWs(s, j);
    const found = findOp(s, j);
    if (found === null) {
      throw new CheckParseError(
        raw,
        `位置 ${j}: 未找到合法 op (字面量开头的 check 只允许 in / not in)`,
      );
    }
    const [op, opPos] = found;
    if (op !== Op.IN && op !== Op.NOT_IN) {
      throw new CheckParseError(
        raw,
        `op ${pyRepr(op)} 不允许 lhs 为字面量 ` + `(字面量开头的 check 只允许 in / not in)`,
      );
    }
    let k = skipWs(s, opPos + (op as string).length);
    if (k >= s.length) {
      throw new CheckParseError(raw, "缺少 rhs (期望字段路径)");
    }
    let rhsField: string;
    let end: number;
    [rhsField, end] = parseIdentifier(s, k);
    end = skipWs(s, end);
    if (end !== s.length) {
      throw new CheckParseError(
        raw,
        `位置 ${end}: rhs 之后存在未消化内容 ${pyRepr(s.slice(end))} (只允许单个 lhs op rhs)`,
      );
    }
    // 规范化: lhs=字段, rhs=字面量
    return { raw, lhs: rhsField, op, rhs: lhsLiteral };
  }

  // 路径 B: lhs 是字段路径标识符
  let lhs: string;
  let j: number;
  [lhs, j] = parseIdentifier(s, i);
  j = skipWs(s, j);
  const found = findOp(s, j);
  if (found === null) {
    throw new CheckParseError(
      raw,
      `位置 ${j}: 未找到合法 op (白名单: ${JSON.stringify([...OP_VALUES])})`,
    );
  }
  const [op, opPos] = found;
  const k = skipWs(s, opPos + (op as string).length);
  if (k >= s.length) {
    throw new CheckParseError(raw, "缺少 rhs");
  }

  let rhs: unknown;
  let end: number;
  [rhs, end] = parseScalarLiteral(s, k);
  end = skipWs(s, end);
  if (end !== s.length) {
    throw new CheckParseError(
      raw,
      `位置 ${end}: rhs 之后存在未消化内容 ${pyRepr(s.slice(end))} (只允许单个 lhs op rhs)`,
    );
  }
  return { raw, lhs, op, rhs };
}

// ---------------------------------------------------------------------------
// eval_check / eval_case / eval_task
// ---------------------------------------------------------------------------

/**
 * 数字判定: number 但排除 bool。
 *
 * JS 中布尔不是 number (`typeof true === "boolean"`), 故只需判 `typeof === "number"`;
 * 仍排除 NaN 以保守 (Python 端不会出现 NaN 字面量)。
 */
function isNumber(v: unknown): v is number {
  return typeof v === "number" && !Number.isNaN(v);
}

/** 列表深比较 (用于数组 rhs 的 == / != / in 成员判定)。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/** TS typeof → 近似 Python type 名 (用于错误信息中的类型描述)。 */
function pyTypeName(v: unknown): string {
  if (v === null) {
    return "NoneType";
  }
  if (typeof v === "boolean") {
    return "bool";
  }
  if (typeof v === "number") {
    return Number.isInteger(v) ? "int" : "float";
  }
  if (typeof v === "string") {
    return "str";
  }
  if (Array.isArray(v)) {
    return "list";
  }
  return typeof v;
}

/**
 * 对单条 check 在给定 caseFields 下求值。
 *
 * @param check 已解析的 Check。
 * @param caseFields case 输出 schema 固定字段 {id, passed, failure_reason}。
 *
 * 说明:
 * - 未知字段路径 -> passed=false, error="unknown field: ..." (§3.1)。
 * - 类型不兼容 (如对 bool 用 <) -> passed=false, error=诊断。
 * - 不 silent coerce。
 */
export function evalCheck(check: Check, caseFields: Record<string, unknown>): CheckEvalResult {
  const op = check.op;
  // 未知字段
  if (!Object.prototype.hasOwnProperty.call(caseFields, check.lhs)) {
    const keys = Object.keys(caseFields).sort();
    return {
      check,
      passed: false,
      error:
        `unknown field: ${pyRepr(check.lhs)} (case schema 固定字段: ` +
        `${JSON.stringify(keys)})`,
    };
  }

  const lhsVal = caseFields[check.lhs];

  let ok: boolean;
  if (op === Op.EQ) {
    ok = deepEqual(lhsVal, check.rhs);
  } else if (op === Op.NE) {
    ok = !deepEqual(lhsVal, check.rhs);
  } else if (op === Op.IN) {
    // 语义按 lhs 值类型分派:
    // - 数组字段 (design §3.1): rhs 是 scalar, 检查 "rhs ∈ field 值" (成员判定)。
    // - 字符串字段且 rhs 也是字符串: 子串判定 (failure_reason 负路径, 方向 B)。
    // - 其它组合: 类型错误 (不 coerce)。
    if (Array.isArray(lhsVal)) {
      ok = lhsVal.some((el) => deepEqual(el, check.rhs));
    } else if (typeof lhsVal === "string" && typeof check.rhs === "string") {
      ok = lhsVal.includes(check.rhs);
    } else {
      return {
        check,
        passed: false,
        error:
          `op 'in' 要求字段 ${pyRepr(check.lhs)} 是数组, 或字段与 rhs 均为字符串 (子串判定); ` +
          `实际字段类型 ${pyTypeName(lhsVal)}, rhs 类型 ${pyTypeName(check.rhs)}`,
      };
    }
  } else if (op === Op.NOT_IN) {
    if (Array.isArray(lhsVal)) {
      ok = !lhsVal.some((el) => deepEqual(el, check.rhs));
    } else if (typeof lhsVal === "string" && typeof check.rhs === "string") {
      ok = !lhsVal.includes(check.rhs);
    } else {
      return {
        check,
        passed: false,
        error:
          `op 'not in' 要求字段 ${pyRepr(check.lhs)} 是数组, 或字段与 rhs 均为字符串 (子串判定); ` +
          `实际字段类型 ${pyTypeName(lhsVal)}, rhs 类型 ${pyTypeName(check.rhs)}`,
      };
    }
  } else if (op === Op.LT || op === Op.LE || op === Op.GT || op === Op.GE) {
    // 数字比较: 双方都必须是 number (排除 bool)。
    if (!isNumber(lhsVal)) {
      return {
        check,
        passed: false,
        error:
          `op ${pyRepr(op)} 要求字段 ${pyRepr(check.lhs)} 是数字, ` +
          `实际类型 ${pyTypeName(lhsVal)} (bool 与 int 比较无意义)`,
      };
    }
    if (!isNumber(check.rhs)) {
      return {
        check,
        passed: false,
        error: `op ${pyRepr(op)} 要求 rhs 是数字, 实际类型 ${pyTypeName(check.rhs)}`,
      };
    }
    if (op === Op.LT) {
      ok = lhsVal < check.rhs;
    } else if (op === Op.LE) {
      ok = lhsVal <= check.rhs;
    } else if (op === Op.GT) {
      ok = lhsVal > check.rhs;
    } else {
      // GE
      ok = lhsVal >= check.rhs;
    }
  } else {
    // 兜底 (Op 全覆盖, 理论不可达)
    return { check, passed: false, error: `未支持的 op: ${op}` };
  }

  return { check, passed: Boolean(ok), error: null };
}

/**
 * 对单 case 的全部 checks 求值。
 *
 * 防御性: 只从 caseResult 取 schema 固定三字段做 caseFields, 即使 worker
 * 绕过 schema (理论上 strict 已挡), coordinator 也不认自创字段。
 */
export function evalCase(testCase: TestCase, caseResult: TestCaseResult): CaseEvalResult {
  // 防御性白名单提取 (不直接展开整对象以防 schema 层放宽后漏检)
  const caseFields: Record<string, unknown> = {
    id: caseResult.id,
    passed: caseResult.passed,
    failure_reason: caseResult.failure_reason,
  };

  const checkResults: CheckEvalResult[] = [];
  for (const raw of testCase.checks) {
    let chk: Check;
    try {
      chk = parseCheck(raw);
    } catch (e) {
      if (e instanceof CheckParseError) {
        checkResults.push({
          // 占位 check
          check: { raw, lhs: "", op: Op.EQ, rhs: null },
          passed: false,
          error: `parse error: ${e.reason}`,
        });
        continue;
      }
      throw e;
    }
    checkResults.push(evalCheck(chk, caseFields));
  }

  return makeCaseEvalResult(testCase.id, checkResults);
}

/**
 * 对单 task 全部 case 的求值汇总。
 *
 * @param testResults worker 交回的 test-results.yaml 解析结果。
 * @param testCases   task-plan 里该 task 声明的 cases。
 * @param taskId      仅用于结果回显。
 *
 * 返回 TaskCheckEvalResult, 含:
 *   - 每个 planned case 的 CaseEvalResult (planned 但没跑 -> 视为失败)
 *   - warnings: worker 多跑但没 planned 的 case id 列表
 */
export function evalTask(
  testResults: TestResults,
  testCases: TestCase[],
  taskId: string,
): TaskCheckEvalResult {
  // 按 id 索引 worker 交回结果
  const workerById = new Map<string, TestCaseResult>();
  for (const c of testResults.cases) {
    workerById.set(c.id, c);
  }

  const caseResults: CaseEvalResult[] = [];
  const warnings: string[] = [];

  for (const planned of testCases) {
    const worker = workerById.get(planned.id);
    if (worker === undefined) {
      // planned 但 worker 没跑 -> case 失败
      caseResults.push(
        makeCaseEvalResult(planned.id, [
          {
            check: { raw: "", lhs: "", op: Op.EQ, rhs: null },
            passed: false,
            error: "case not run: worker 未交回该 planned case",
          },
        ]),
      );
      continue;
    }
    caseResults.push(evalCase(planned, worker));
  }

  // 多余的 case (worker 跑了但没 planned)
  const plannedIds = new Set(testCases.map((c) => c.id));
  for (const extraId of workerById.keys()) {
    if (!plannedIds.has(extraId)) {
      warnings.push(`extra case reported but not planned: ${extraId}`);
    }
  }

  return makeTaskCheckEvalResult(taskId, caseResults, warnings);
}

// ---------------------------------------------------------------------------
// 结果构造工厂 (计算派生属性 passed / tests_green, 等价 Python @property)
// ---------------------------------------------------------------------------

/** 构造 CaseEvalResult, 计算 passed = 至少一条 check 且全部通过。 */
function makeCaseEvalResult(
  caseId: string,
  checkResults: CheckEvalResult[],
): CaseEvalResult {
  const passed = checkResults.length > 0 && checkResults.every((r) => r.passed);
  return { case_id: caseId, check_results: checkResults, passed };
}

/** 构造 TaskCheckEvalResult, 计算 tests_green = 至少一个 case 且全部通过。 */
function makeTaskCheckEvalResult(
  taskId: string,
  caseResults: CaseEvalResult[],
  warnings: string[],
): TaskCheckEvalResult {
  const testsGreen = caseResults.length > 0 && caseResults.every((c) => c.passed);
  return { task_id: taskId, case_results: caseResults, warnings, tests_green: testsGreen };
}
