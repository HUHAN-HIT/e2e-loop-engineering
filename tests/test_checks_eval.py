"""checks 文法求值器测试 (design §3.1).

覆盖:
- parse_check 的文法白名单 (合法 op / 拒绝函数调用 / 嵌套 / 未知 op / 未闭合引号)
- eval_check 的未知字段失败、类型不兼容、in/not in 成员、数字比较
- eval_task 的 planned-未跑、worker 多跑、worker 自创字段防御
"""
from __future__ import annotations

import pytest

from loop_engineering.checklists.checks_eval import (
    CaseEvalResult,
    Check,
    CheckEvalResult,
    CheckParseError,
    Op,
    TaskCheckEvalResult,
    eval_case,
    eval_check,
    eval_task,
    parse_check,
)
from loop_engineering.schema.artifacts import TestCaseResult, TestResults
from loop_engineering.schema.task_plan import TestCase


# ---------------------------------------------------------------------------
# parse_check —— 文法白名单
# ---------------------------------------------------------------------------

class TestParseCheck:
    def test_parse_eq_bool(self) -> None:
        c = parse_check("passed == true")
        assert c.lhs == "passed"
        assert c.op == Op.EQ
        assert c.rhs is True

    def test_parse_ne_string(self) -> None:
        # design 约定: lhs 永远是字段路径 (无引号), rhs 是字面量 (有引号/数字/bool)
        # 这里 lhs = blocked_reasons, op = !=, rhs = 'not_approved'
        c = parse_check("blocked_reasons != 'not_approved'")
        assert c.lhs == "blocked_reasons"
        assert c.op == Op.NE
        assert c.rhs == "not_approved"

    def test_parse_in_array(self) -> None:
        # design §3.1 示例: '<scalar>' in <array-field>
        # lhs = blocked_reasons (数组字段), op = in, rhs = 'clarification_not_approved'
        # 语义: rhs ∈ lhs_val (字段值视作集合)
        c = parse_check("'clarification_not_approved' in blocked_reasons")
        assert c.lhs == "blocked_reasons"
        assert c.op == Op.IN
        assert c.rhs == "clarification_not_approved"

    def test_parse_not_in(self) -> None:
        # x not in y —— y 是裸词, parse_check 拒绝 (rhs 必须是字面量, 防止字段引用伪装)
        # 这里验证 op 优先级 (not in 必须先于 in 识别) + 合法字面量版本
        c2 = parse_check("x not in 'foo'")
        assert c2.op == Op.NOT_IN
        assert c2.rhs == "foo"
        # 反向语法 (字面量在前): 'foo' not in x —— x 是字段路径, 合法
        c3 = parse_check("'foo' not in x")
        assert c3.op == Op.NOT_IN
        assert c3.lhs == "x"
        assert c3.rhs == "foo"
        # 关键: 不能误识别为 op=IN (验证 not in 优先级)
        # (用引号字符串让 in 不出现在 'not' 后的误匹配中)
        c4 = parse_check("'foo' in tags")
        assert c4.op == Op.IN
        # not in 必须整个匹配, 不会把 'not in' 拆成两段
        c5 = parse_check("'foo' not in tags")
        assert c5.op == Op.NOT_IN

    def test_parse_numeric_comparisons(self) -> None:
        for raw, op in [
            ("count < 10", Op.LT),
            ("count <= 10", Op.LE),
            ("count > 10", Op.GT),
            ("count >= 10", Op.GE),
        ]:
            c = parse_check(raw)
            assert c.op == op
            assert c.lhs == "count"
            assert c.rhs == 10

    def test_parse_rhs_array(self) -> None:
        c = parse_check("x == [a, b]")
        assert c.op == Op.EQ
        assert c.rhs == ["a", "b"]

    def test_parse_reject_function_call(self) -> None:
        with pytest.raises(CheckParseError) as ei:
            parse_check("len(x) == 3")
        assert "括号" in ei.value.reason or "函数" in ei.value.reason or "括号" in str(ei.value)

    def test_parse_reject_nested_expr(self) -> None:
        with pytest.raises(CheckParseError):
            parse_check("(a == b) == true")

    def test_parse_reject_unknown_op(self) -> None:
        # := 不是合法 op
        with pytest.raises(CheckParseError) as ei:
            parse_check("x := y")
        assert "op" in ei.value.reason.lower() or "op" in str(ei.value).lower()

    def test_parse_reject_unclosed_quote(self) -> None:
        with pytest.raises(CheckParseError) as ei:
            parse_check("x == 'abc")
        assert "闭合" in ei.value.reason or "闭合" in str(ei.value)


# ---------------------------------------------------------------------------
# eval_check
# ---------------------------------------------------------------------------

class TestEvalCheck:
    def _chk(self, raw: str) -> Check:
        return parse_check(raw)

    def test_eval_eq_bool_pass(self) -> None:
        r = eval_check(self._chk("passed == true"), {"passed": True})
        assert r.passed is True
        assert r.error is None

    def test_eval_eq_bool_fail(self) -> None:
        r = eval_check(self._chk("passed == true"), {"passed": False})
        assert r.passed is False
        assert r.error is None

    def test_eval_unknown_field_fails(self) -> None:
        # §3.1 关键: 未知字段路径 -> passed=False + error
        r = eval_check(self._chk("'x' in blocked_reasons"), {"passed": True, "failure_reason": ""})
        assert r.passed is False
        assert r.error is not None
        assert "blocked_reasons" in r.error

    def test_eval_in_membership(self) -> None:
        # design §3.1: 'a' in tags -> 字段 tags 是数组, rhs='a', 判 'a' ∈ tags
        r = eval_check(self._chk("'a' in tags"), {"tags": ["a", "b"]})
        assert r.passed is True
        assert r.error is None

    def test_eval_not_in_membership(self) -> None:
        r = eval_check(self._chk("'c' not in tags"), {"tags": ["a", "b"]})
        assert r.passed is True
        assert r.error is None

    def test_eval_numeric_lt(self) -> None:
        r = eval_check(self._chk("count < 10"), {"count": 5})
        assert r.passed is True
        assert r.error is None

    def test_eval_type_mismatch_fails(self) -> None:
        # bool 与 int 比较无意义 (design: 不 silent coerce)
        r = eval_check(self._chk("passed < 10"), {"passed": True})
        assert r.passed is False
        assert r.error is not None
        assert "数字" in r.error or "类型" in r.error or "数字" in str(r.error)


# ---------------------------------------------------------------------------
# eval_task
# ---------------------------------------------------------------------------

def _make_case(case_id: str, checks: list[str]) -> TestCase:
    return TestCase(id=case_id, scenario=f"scenario for {case_id}", checks=checks)


def _make_case_result(case_id: str, passed: bool, failure_reason: str = "") -> TestCaseResult:
    return TestCaseResult(id=case_id, passed=passed, failure_reason=failure_reason)


class TestEvalTask:
    def test_eval_task_all_pass(self) -> None:
        test_cases = [
            _make_case("c1", ["passed == true"]),
            _make_case("c2", ["passed == true"]),
            _make_case("c3", ["passed == true"]),
        ]
        results = TestResults(
            tests_green=True,
            cases=[
                _make_case_result("c1", True),
                _make_case_result("c2", True),
                _make_case_result("c3", True),
            ],
        )
        r = eval_task(results, test_cases, "t1")
        assert isinstance(r, TaskCheckEvalResult)
        assert r.task_id == "t1"
        assert r.tests_green is True
        assert r.warnings == []
        assert len(r.case_results) == 3

    def test_eval_task_missing_case_fails(self) -> None:
        # planned c1, c2; worker 只跑了 c1
        test_cases = [_make_case("c1", ["passed == true"]), _make_case("c2", ["passed == true"])]
        results = TestResults(
            tests_green=False,
            cases=[_make_case_result("c1", True)],  # c2 没跑
        )
        r = eval_task(results, test_cases, "t1")
        assert r.tests_green is False
        # c2 视为失败
        c2 = next(cr for cr in r.case_results if cr.case_id == "c2")
        assert c2.passed is False
        assert any("not run" in (chk.error or "") for chk in c2.check_results)

    def test_eval_task_extra_case_warns(self) -> None:
        # planned c1; worker 跑了 c1 + 多余的 c2
        test_cases = [_make_case("c1", ["passed == true"])]
        results = TestResults(
            tests_green=True,
            cases=[
                _make_case_result("c1", True),
                _make_case_result("c2", True),  # extra
            ],
        )
        r = eval_task(results, test_cases, "t1")
        # extra case 不直接导致 tests_green 失败 (但会上报 warning)
        assert r.tests_green is True
        assert any("extra case" in w for w in r.warnings)
        assert any("c2" in w for w in r.warnings)

    def test_eval_task_worker_invents_field(self) -> None:
        """schema 层 extra=forbid 已挡, 但 eval_case 仍只取三字段做 defensive."""
        # 构造一个合法 TestCaseResult (schema extra=forbid 会拒绝自创字段, 无法绕过),
        # 这里验证 eval_case 提取出的 fields 只有 {id, passed, failure_reason}.
        case = _make_case("c1", ["passed == true"])
        cr = _make_case_result("c1", True)
        res = eval_case(case, cr)
        assert res.case_id == "c1"
        assert res.passed is True
        # 验证: 即使 case.checks 引用了某个自创字段, 也会被判失败 (字段不存在)
        case2 = _make_case("c2", ["my_invented_field == true"])
        cr2 = _make_case_result("c2", True)
        res2 = eval_case(case2, cr2)
        assert res2.passed is False
        assert any("my_invented_field" in (c.error or "") for c in res2.check_results)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
