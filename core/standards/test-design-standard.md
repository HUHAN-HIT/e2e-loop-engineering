# 测试设计 craft 标准 (TEST DESIGN)

> 适用角色: `plan-agent` (设计 planned 用例时) 与 `implementation-worker` (落成测试代码时)。两端共用本标准, 确保"设计的用例"与"写出的测试"是同一回事。
> 本标准回答: 怎么从一条 AC 推导出真正覆盖它的用例、覆盖到什么程度、checks 怎么写才"可机械判定"。
> 可机械判定的术语判据见 `glossary.md` §1; checks 文法求值见 `@e2e-loop/ssot/checklists` 的 `parseCheck` / `evalCheck`。

体例: 推导链 → 覆盖规则 → 断言正/反例 → worked example。规则带 `[S][M][C]` 档标记。

---

## 0. 一句话定位

测试设计**在 plan 阶段定死, 不许 implementation worker 临场发明验收口径** (SKILL §2.5 的"测试先于实现"是设计纪律, 不是防伪时序)。每条 AC 必须先变成"测什么 (scenario) + 断言哪些可机械判定的字段 (checks)", 否则这条 AC 就无法被证明完成。

**关键澄清:** 本范式**砍掉了**旧版的 `red_first` 时序、`assert_fields`、`expected_evidence` 这些**防伪包装**。worker 先写测试看它红, 是**自己的开发节奏**, 不需要向任何人证明时序。本标准只管"用例设计得好不好", 不管"怎么证明你真按 TDD 做了"。

---

## 1. AC → scenario → checks → 测试代码 推导链

每条 AC 走一遍这条链, 缺环即不合格:

```
AC (可观测行为)
  → scenario (这条 AC 在什么情形下、做什么动作)
    → checks (动作后, 哪些可观测字段应是什么值 —— 可机械判定)
      → 测试代码 (worker 在 IMPLEMENTING 阶段把 checks 落成断言)
```

**每环的判据:** `[S][M][C]`
1. **scenario**: 一句话, 含"情形 + 动作", 指向**一条**具体 AC (`acceptance_refs`)。不写"测试登录"这种没有动作的标题。
2. **checks**: 每条形如 `<lhs> <op> <rhs>`——lhs 是产物里**可观测的输出字段路径** (如 `ok`、`reason`、`status`、`blocked_reasons`), op ∈ `{==,!=,in,not in,<,<=,>,>=}`, rhs 是字面量。
3. **可落地**: worker 拿到 scenario+checks, 不需要再问就能写出测试。写不出机械断言 → 该用例**退回重写**, 不放行。

---

## 2. 覆盖规则 (分档)

| 档 | 每条 AC 至少 | 负向用例 | 边界 |
| --- | --- | --- | --- |
| simple `[S]` | 1 个 happy-path 用例 | 不强制 | 不强制 |
| medium `[M]` | 1 个用例 | 控制面/校验类 AC 建议 1 个 | 关键边界建议覆盖 |
| complex `[C]` | 1 个用例 | **状态机/控制面/并发 AC 必须 ≥1 负向** | 关键边界必须覆盖 |

**负向用例 = 测"错误输入/非法状态/越权"时系统是否正确拒绝**, 不是测 happy path 的变体。控制面 task (鉴权/校验/状态机/迁移) 没有负向用例 = 计划自检不过。

**边界 = 测临界值** (0 / 1 / 上限 / 上限+1 / 空 / 超长)。例: 验证码 5 位 → 测 4 位被拒、6 位被拒。

---

## 3. checks 怎么写才"可机械判定"——反例清单 (关闭评审 A6)

这是本标准最硬的部分。**checks 不是测试代码, 是给 coordinator 机械求值的断言**, 所以不许含语义、函数、嵌套。

| ✗ 不可机械判定 | 为什么 | ✓ 改写 |
| --- | --- | --- |
| `结果正确` | 自然语言, 无字段无算子 | `ok == true` |
| `passed == is_valid(x)` | 含函数调用 | 先把 is_valid 的结果落成产物字段: `passed == true` |
| `状态合理` | 形容词 | `status == 'active'` |
| `reason 包含错误信息` | "包含""信息"不可判 | `reason == 'captcha_invalid'` |
| `len(x) > 0 and y == 1` | 表达式嵌套/逻辑连接 | 拆成两条: `count > 0`、`y == 1` |
| `response 看起来对` | 主观 | `code == 200`、`'token' in response_keys` |
| `大致 5 位` | 模糊 | `digit_count == 5` |

**自检口诀:** 一条 check 若换个 agent 来判可能给出不同结论, 它就不是机械可判定的——退回重写。

---

## 4. 产物字段约定 (worker 侧)

worker 把 checks 落成测试后, 产 `tasks/<id>/test-results.yaml`:

```yaml
tests_green: true
cases:
  - { id: T02-CASE-002, passed: false, failure_reason: "" }   # passed 供 coordinator 对 checks 机械求值
```

**每个 case 只准填 `id` / `passed` / `failure_reason` 三个固定字段, 不得自创字段** (自创/未知字段 → 该 check 判失败 + 告警)。求值规则见 `@e2e-loop/ssot/checklists` 的 `evalCase`。`passed` 是 case 的整体真假, 由 worker 跑测试得到; checks 里的具体字段值由 worker 在测试代码内断言, coordinator 只对 case 级 `passed` 与 planned checks 做一致性核对。

---

## 5. Worked example

**AC-002:** `提交错误验证码时, 校验接口返回 {ok:false, reason:"captcha_invalid"}`。

**推导:**
- scenario (negative): "提交一个错误的验证码, 期望被拒并给出原因"。
- checks: `["ok == false", "reason == 'captcha_invalid'"]` —— 两个可观测字段, 字面量右值, 可机械判定。
- 边界补充 `[C]`: 再加 scenario "提交空验证码" → checks `["ok == false", "reason == 'captcha_empty'"]`。
- worker 落地: 写 `test_verify.py::test_wrong_captcha_rejected`, 构造错误验证码请求, 断言响应 `ok is False and reason == "captcha_invalid"`, 跑绿, 在 test-results.yaml 填 `{id: T02-CASE-002, passed: true, failure_reason: ""}`。

**反范式:** 把 scenario 写成 "测校验" (无动作)、checks 写成 `["校验失败时报错"]` (自然语言) —— 两者都退回重写。

---

## 6. 红线

- planned 用例与 checks 是契约; implementation worker **不得擅自删除/弱化/改名**。不可执行或本身错了 → 返回 `plan-amendment-needed` 回 PLANNING (见 `implementation-standard.md`), 不硬做、不偷改。
- 不写 `red_first` / `assert_fields` / `expected_evidence` 这类旧范式防伪包装。
- 不确定某项怎么测 → 不许跳过: 写出测试假设, 或标记需澄清/amendment。
