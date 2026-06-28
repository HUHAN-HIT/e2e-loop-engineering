"""checks 文法求值器 (design §3.1).

文法白名单: 仅允许 `<lhs> <op> <rhs>`:
- lhs  : case 输出 schema 固定字段路径 (无引号标识符, 如 `passed`、`blocked_reasons`)
- op   : {==, !=, in, not in, <, <=, >, >=}
- rhs  : 字面量 (bool / int / float / 单/双引号字符串 / 方括号数组)

不允许函数调用、表达式嵌套、自然语言. 手写递归下降解析, 不引解析器库.

case 输出 schema 严格固定为 {id, passed: bool, failure_reason: str} (§3.1).
coordinator 求值时只认这三字段; 遇未知字段路径 -> 判该 check 失败 + 告警.

`in` / `not in` 语义方向 (design §3.1 示例 `'<scalar>' in <array-field>`):
字段值是数组时, rhs 是 scalar, 检查 "rhs ∈ field 值".
即 lhs 仍是字段路径, op 是 `in`, rhs 是 scalar, 求值时把 field 值视作集合.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from loop_engineering.schema.artifacts import TestCaseResult, TestResults
from loop_engineering.schema.task_plan import TestCase


class CheckParseError(ValueError):
    """check 文法解析失败.

    Attributes:
        raw: 原始 check 字符串 (回显).
        reason: 诊断信息.
    """

    def __init__(self, raw: str, reason: str) -> None:
        self.raw = raw
        self.reason = reason
        super().__init__(f"check parse error: {reason} (raw={raw!r})")


class Op(StrEnum):
    """check 比较操作符白名单."""

    EQ = "=="
    NE = "!="
    IN = "in"
    NOT_IN = "not in"
    LT = "<"
    LE = "<="
    GT = ">"
    GE = ">="


# 操作符按"最长优先"排序, 避免把 `not in` 误识别成 `in` / `not`.
# 解析时按此顺序扫描前缀匹配.
_OPS_BY_LENGTH: tuple[Op, ...] = (
    Op.NOT_IN,  # "not in" 6 字符, 最长
    Op.EQ,      # "=="
    Op.NE,      # "!="
    Op.LE,      # "<="
    Op.GE,      # ">="
    Op.LT,      # "<"
    Op.GT,      # ">"
    Op.IN,      # "in"
)


@dataclass(frozen=True)
class Check:
    """解析后的 check: lhs op rhs."""

    raw: str
    lhs: str
    op: Op
    rhs: Any


@dataclass(frozen=True)
class CheckEvalResult:
    """单条 check 求值结果."""

    check: Check
    passed: bool
    error: str | None = None


@dataclass(frozen=True)
class CaseEvalResult:
    """单个 test case 的全部 checks 求值结果."""

    case_id: str
    check_results: list[CheckEvalResult] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        """case 通过 = 至少有一条 check 且全部通过."""
        return bool(self.check_results) and all(r.passed for r in self.check_results)


@dataclass(frozen=True)
class TaskCheckEvalResult:
    """单个 task 全部 case 的求值汇总."""

    task_id: str
    case_results: list[CaseEvalResult] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def tests_green(self) -> bool:
        """task 测试全绿 = 至少有一个 case 且全部通过."""
        return bool(self.case_results) and all(c.passed for c in self.case_results)


# ---------------------------------------------------------------------------
# parse_check —— 手写递归下降解析
# ---------------------------------------------------------------------------

def _skip_ws(s: str, i: int) -> int:
    """跳过空白 (空格 / tab)."""
    while i < len(s) and s[i] in " \t":
        i += 1
    return i


def _parse_identifier(s: str, i: int) -> tuple[str, int]:
    """解析 lhs 字段路径标识符.

    支持 `a.b.c` 风格 (设计上预留 JSONPath 子集), 但当前 schema 固定字段
    都是单段 (`passed`, `failure_reason`), 故仅允许字母数字 + 下划线 + 点.
    不允许前导数字 (避免与数字字面量混淆).
    """
    start = i
    if i >= len(s) or not (s[i].isalpha() or s[i] == "_"):
        raise CheckParseError(s, f"位置 {i}: 字段路径必须以字母/下划线开头")
    while i < len(s) and (s[i].isalnum() or s[i] in "._"):
        i += 1
    return s[start:i], i


def _parse_quoted_string(s: str, i: int) -> tuple[str, int]:
    """解析单/双引号字符串, 不支持转义 (文法刻意极简)."""
    quote = s[i]
    assert quote in "'\"", "内部错误: _parse_quoted_string 入口非引号"
    j = i + 1
    buf: list[str] = []
    while j < len(s):
        c = s[j]
        if c == quote:
            return "".join(buf), j + 1
        buf.append(c)
        j += 1
    raise CheckParseError(s, f"位置 {i}: 字符串引号未闭合 (到末尾仍未找到匹配的 {quote})")


def _parse_array(s: str, i: int) -> tuple[list[Any], int]:
    """解析方括号数组 `[a, b, c]`.

    元素按"裸标识符或字面量"解析, 每个元素都被解释成"字符串或数字或 bool".
    design §3.1: 数组元素字面量规则与顶层 rhs 一致.
    """
    assert s[i] == "[", "内部错误: _parse_array 入口非 ["
    j = i + 1
    items: list[Any] = []
    while True:
        j = _skip_ws(s, j)
        if j >= len(s):
            raise CheckParseError(s, "位置 {}: 数组未闭合 (到末尾仍未找到 ])".format(i))
        if s[j] == "]":
            return items, j + 1
        # 解析单个元素 (数组内裸词按字符串)
        item, j = _parse_literal_inner(s, j, in_array=True)
        items.append(item)
        j = _skip_ws(s, j)
        if j >= len(s):
            raise CheckParseError(s, "位置 {}: 数组未闭合 (元素后到末尾)".format(i))
        if s[j] == ",":
            j += 1
            continue
        if s[j] == "]":
            return items, j + 1
        raise CheckParseError(s, f"位置 {j}: 数组元素后必须跟 ',' 或 ']', 实际为 {s[j]!r}")


def _parse_scalar_literal(s: str, i: int) -> tuple[Any, int]:
    """解析标量字面量 (字符串 / 数字 / bool / 数组).

    顶层 rhs 位置不允许裸标识符 (除 true/false/null) —— 防止 worker 用裸词伪装
    字段引用 (§3.1). 但数组 `[a, b]` 内部裸词按字符串字面量解析 (design 示例:
    `x == [a, b]` 表示成员取值 a/b 的字符串数组).
    """
    return _parse_literal_inner(s, i, in_array=False)


def _parse_literal_inner(s: str, i: int, *, in_array: bool) -> tuple[Any, int]:
    """标量字面量解析核心. in_array=True 时裸词视作字符串."""
    i = _skip_ws(s, i)
    if i >= len(s):
        raise CheckParseError(s, f"位置 {i}: 期望字面量但到末尾")
    c = s[i]
    # 引号字符串
    if c in "'\"":
        return _parse_quoted_string(s, i)
    # 数组
    if c == "[":
        # 数组内嵌套数组按非法处理 (不允许嵌套) —— _parse_array 已隐式保证
        return _parse_array(s, i)
    # 数字 (含负号)
    if c == "-" or c.isdigit():
        return _parse_number(s, i)
    # 裸词
    if c.isalpha() or c == "_":
        word, end = _parse_bare_word(s, i)
        low = word.lower()
        if low == "true":
            return True, end
        if low == "false":
            return False, end
        if low in ("null", "none"):
            return None, end
        if in_array:
            # 数组内: 裸词按字符串字面量
            return word, end
        # 顶层 rhs: 拒绝裸词 (要求加引号; 防止 worker 用裸标识符伪装字段引用)
        raise CheckParseError(
            s,
            f"位置 {i}: rhs 裸词 {word!r} 不合法 (仅允许 true/false/null); "
            f"若为字符串字面量请加引号",
        )
    raise CheckParseError(s, f"位置 {i}: 字面量以非法字符 {c!r} 开头")


def _parse_number(s: str, i: int) -> tuple[int | float, int]:
    """解析整数或浮点 (无科学记数法, 极简)."""
    start = i
    if s[i] == "-":
        i += 1
    seen_dot = False
    while i < len(s) and (s[i].isdigit() or s[i] == "."):
        if s[i] == ".":
            if seen_dot:
                raise CheckParseError(s, f"位置 {i}: 数字含多个小数点")
            seen_dot = True
        i += 1
    token = s[start:i]
    if token in ("", "-"):
        raise CheckParseError(s, f"位置 {start}: 数字字面量不完整")
    try:
        return (float(token) if seen_dot else int(token)), i
    except ValueError as e:
        raise CheckParseError(s, f"位置 {start}: 无法解析数字 {token!r}: {e}") from e


def _parse_bare_word(s: str, i: int) -> tuple[str, int]:
    """解析裸词 (字母/下划线/数字), 不解释其语义."""
    start = i
    while i < len(s) and (s[i].isalnum() or s[i] == "_"):
        i += 1
    return s[start:i], i


def _find_op(s: str, start: int) -> tuple[Op, int] | None:
    """从 start 位置向右扫描第一个出现的合法 op.

    策略: 在每个候选分割点按 _OPS_BY_LENGTH (长 op 优先) 做前缀匹配.
    要求 op 前后都是空白 (避免把 `index` 里的 `in` 误识别).
    """
    n = len(s)
    i = start
    while i < n:
        # op 必须前后是空白 (或字符串边界). lhs 已被解析到 i 之前.
        # 这里 i 是 op 起点候选.
        for op in _OPS_BY_LENGTH:
            op_str = op.value
            end = i + len(op_str)
            if end > n:
                continue
            if s[i:end] != op_str:
                continue
            # 前导必须是空白 (或边界)
            if i > start and s[i - 1] not in " \t":
                continue
            # 后继: in / not in 后面必须跟空白; 二元符号 ==/!=/</... 后面也要求空白或 rhs 边界
            if end < n and s[end] not in " \t":
                continue
            return op, i
        i += 1
    return None


def _first_nonspace(s: str, i: int) -> str | None:
    """从 i 开始的第一个非空白字符 (None 表示到末尾)."""
    j = _skip_ws(s, i)
    return s[j] if j < len(s) else None


def parse_check(raw: str) -> Check:
    """解析单条 check 字符串 -> Check.

    支持两种语法顺序 (design §3.1 示例驱动):
        1. `<field> <op> <literal>`   —— 通用形式 (==, !=, <, <=, >, >= 等)
        2. `<literal> in <field>`      —— `in` / `not in` 的惯用写法
           (design 示例: `'clarification_not_approved' in blocked_reasons`)

    求值时 lhs 永远规范化为字段路径, rhs 永远规范化为字面量:
        `<scalar> in <field>`  -> Check(lhs=<field>, op=IN, rhs=<scalar>)
        `<field> in <list>`    -> 同上, 但要求 field 值是 scalar 且 rhs 是 list
                                  (反向语义: field ∈ rhs; eval_check 按字段类型判定)

    Args:
        raw: 原始 check 字符串.

    Returns:
        Check 实例.

    Raises:
        CheckParseError: 任何文法违规 (函数调用、嵌套、未闭合引号、未知 op 等).
    """
    if not isinstance(raw, str):
        raise CheckParseError(str(raw), "check 必须是字符串")
    s = raw.strip()
    if not s:
        raise CheckParseError(raw, "check 为空字符串")

    # 拒绝嵌套括号 / 函数调用 (在解析前用结构检查兜底)
    if "(" in s or ")" in s:
        raise CheckParseError(raw, "不允许括号 (含函数调用 / 嵌套表达式)")
    if "{" in s or "}" in s:
        raise CheckParseError(raw, "不允许花括号")

    i = _skip_ws(s, 0)
    if i >= len(s):
        raise CheckParseError(raw, "check 缺少 lhs")

    first_char = s[i]
    lhs_is_literal = (
        first_char in "'\""
        or first_char.isdigit()
        or first_char == "-"
        or first_char == "["
    )

    # 路径 A: lhs 是字面量 -> op 必须是 in / not in, rhs 必须是字段路径
    if lhs_is_literal:
        lhs_literal, j = _parse_scalar_literal(s, i)
        j = _skip_ws(s, j)
        found = _find_op(s, j)
        if found is None:
            raise CheckParseError(
                raw, f"位置 {j}: 未找到合法 op (字面量开头的 check 只允许 in / not in)"
            )
        op, op_pos = found
        if op not in (Op.IN, Op.NOT_IN):
            raise CheckParseError(
                raw,
                f"op {op.value!r} 不允许 lhs 为字面量 "
                f"(字面量开头的 check 只允许 in / not in)",
            )
        k = _skip_ws(s, op_pos + len(op.value))
        if k >= len(s):
            raise CheckParseError(raw, "缺少 rhs (期望字段路径)")
        rhs_field, end = _parse_identifier(s, k)
        end = _skip_ws(s, end)
        if end != len(s):
            raise CheckParseError(
                raw,
                f"位置 {end}: rhs 之后存在未消化内容 {s[end:]!r} (只允许单个 lhs op rhs)",
            )
        # 规范化: lhs=字段, rhs=字面量
        return Check(raw=raw, lhs=rhs_field, op=op, rhs=lhs_literal)

    # 路径 B: lhs 是字段路径标识符
    lhs, j = _parse_identifier(s, i)
    j = _skip_ws(s, j)
    found = _find_op(s, j)
    if found is None:
        raise CheckParseError(
            raw, f"位置 {j}: 未找到合法 op (白名单: {[o.value for o in Op]})"
        )
    op, op_pos = found
    k = _skip_ws(s, op_pos + len(op.value))
    if k >= len(s):
        raise CheckParseError(raw, "缺少 rhs")

    rhs, end = _parse_scalar_literal(s, k)
    end = _skip_ws(s, end)
    if end != len(s):
        raise CheckParseError(
            raw,
            f"位置 {end}: rhs 之后存在未消化内容 {s[end:]!r} (只允许单个 lhs op rhs)",
        )
    return Check(raw=raw, lhs=lhs, op=op, rhs=rhs)


# ---------------------------------------------------------------------------
# eval_check / eval_case / eval_task
# ---------------------------------------------------------------------------

def _is_number(v: Any) -> bool:
    """数字判定: int/float 但排除 bool (bool 是 int 的子类, 必须排除)."""
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def eval_check(check: Check, case_fields: dict[str, Any]) -> CheckEvalResult:
    """对单条 check 在给定 case_fields 下求值.

    Args:
        check: 已解析的 Check.
        case_fields: case 输出 schema 固定字段 {id, passed, failure_reason}.

    Returns:
        CheckEvalResult: 含 passed / error.

    Notes:
        - 未知字段路径 -> passed=False, error="unknown field: ..." (§3.1).
        - 类型不兼容 (如对 bool 用 <) -> passed=False, error=诊断.
        - 不 silent coerce.
    """
    op = check.op
    # 未知字段
    if check.lhs not in case_fields:
        return CheckEvalResult(
            check=check,
            passed=False,
            error=f"unknown field: {check.lhs!r} (case schema 固定字段: "
                  f"{sorted(case_fields.keys())})",
        )

    lhs_val = case_fields[check.lhs]

    try:
        if op == Op.EQ:
            ok = lhs_val == check.rhs
        elif op == Op.NE:
            ok = lhs_val != check.rhs
        elif op == Op.IN:
            # design §3.1: lhs 是数组字段, rhs 是 scalar, 检查 "rhs ∈ field 值".
            if not isinstance(lhs_val, list):
                return CheckEvalResult(
                    check=check,
                    passed=False,
                    error=f"op 'in' 要求字段 {check.lhs!r} 是数组, 实际类型 {type(lhs_val).__name__}",
                )
            ok = check.rhs in lhs_val
        elif op == Op.NOT_IN:
            if not isinstance(lhs_val, list):
                return CheckEvalResult(
                    check=check,
                    passed=False,
                    error=f"op 'not in' 要求字段 {check.lhs!r} 是数组, 实际类型 {type(lhs_val).__name__}",
                )
            ok = check.rhs not in lhs_val
        elif op in (Op.LT, Op.LE, Op.GT, Op.GE):
            # 数字比较: 双方都必须是 int/float (排除 bool).
            if not _is_number(lhs_val):
                return CheckEvalResult(
                    check=check,
                    passed=False,
                    error=f"op {op.value!r} 要求字段 {check.lhs!r} 是数字, "
                          f"实际类型 {type(lhs_val).__name__} (bool 与 int 比较无意义)",
                )
            if not _is_number(check.rhs):
                return CheckEvalResult(
                    check=check,
                    passed=False,
                    error=f"op {op.value!r} 要求 rhs 是数字, 实际类型 {type(check.rhs).__name__}",
                )
            if op == Op.LT:
                ok = lhs_val < check.rhs
            elif op == Op.LE:
                ok = lhs_val <= check.rhs
            elif op == Op.GT:
                ok = lhs_val > check.rhs
            else:  # GE
                ok = lhs_val >= check.rhs
        else:  # pragma: no cover —— StrEnum 全覆盖, 兜底
            return CheckEvalResult(
                check=check,
                passed=False,
                error=f"未支持的 op: {op}",
            )
    except TypeError as e:
        return CheckEvalResult(
            check=check,
            passed=False,
            error=f"求值类型错误 ({op.value}): {e}",
        )

    return CheckEvalResult(check=check, passed=bool(ok), error=None)


# case schema 固定字段白名单 (design §3.1).
_CASE_SCHEMA_FIELDS: frozenset[str] = frozenset({"id", "passed", "failure_reason"})


def eval_case(case: TestCase, case_result: TestCaseResult) -> CaseEvalResult:
    """对单 case 的全部 checks 求值.

    防御性: 只从 case_result 取 schema 固定三字段做 case_fields, 即使 worker
    绕过 schema (理论上 extra=forbid 已挡), coordinator 也不认自创字段.
    """
    # 防御性白名单提取 (不直接 model_dump() 以防 schema 层放宽后漏检)
    case_fields: dict[str, Any] = {
        "id": case_result.id,
        "passed": case_result.passed,
        "failure_reason": case_result.failure_reason,
    }

    check_results: list[CheckEvalResult] = []
    for raw in case.checks:
        try:
            chk = parse_check(raw)
        except CheckParseError as e:
            check_results.append(
                CheckEvalResult(
                    check=Check(raw=raw, lhs="", op=Op.EQ, rhs=None),  # 占位
                    passed=False,
                    error=f"parse error: {e.reason}",
                )
            )
            continue
        check_results.append(eval_check(chk, case_fields))

    return CaseEvalResult(case_id=case.id, check_results=check_results)


def eval_task(
    test_results: TestResults,
    test_cases: list[TestCase],
    task_id: str,
) -> TaskCheckEvalResult:
    """对单 task 全部 case 的求值汇总.

    Args:
        test_results: worker 交回的 test-results.yaml 解析结果.
        test_cases:   task-plan 里该 task 声明的 cases.
        task_id:      仅用于结果回显.

    Returns:
        TaskCheckEvalResult, 含:
            - 每个 planned case 的 CaseEvalResult (planned 但没跑 -> 视为失败)
            - warnings: worker 多跑但没 planned 的 case id 列表
    """
    # 按 id 索引 worker 交回结果
    worker_by_id: dict[str, TestCaseResult] = {c.id: c for c in test_results.cases}

    case_results: list[CaseEvalResult] = []
    warnings: list[str] = []

    for planned in test_cases:
        if planned.id not in worker_by_id:
            # planned 但 worker 没跑 -> case 失败
            case_results.append(
                CaseEvalResult(
                    case_id=planned.id,
                    check_results=[
                        CheckEvalResult(
                            check=Check(raw="", lhs="", op=Op.EQ, rhs=None),
                            passed=False,
                            error="case not run: worker 未交回该 planned case",
                        )
                    ],
                )
            )
            continue
        case_results.append(eval_case(planned, worker_by_id[planned.id]))

    # 多余的 case (worker 跑了但没 planned)
    planned_ids = {c.id for c in test_cases}
    for extra_id in worker_by_id:
        if extra_id not in planned_ids:
            warnings.append(f"extra case reported but not planned: {extra_id}")

    return TaskCheckEvalResult(
        task_id=task_id,
        case_results=case_results,
        warnings=warnings,
    )
