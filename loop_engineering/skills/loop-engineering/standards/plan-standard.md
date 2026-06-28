# 计划阶段 craft 标准 (PLANNING)

> 适用角色: `plan-agent`。每个 run 分发一次, 一个角色产出全部计划契约, **不引入 reviewer 互相否决**。
> 本标准回答: AC 怎么写、design.md 有哪些章节、任务怎么拆到合适粒度、DAG 怎么搭、task-plan 长什么样。
> 测试用例怎么从 AC 推导、checks 怎么写, 见 `test-design-standard.md` (本阶段必须配套读)。
> 任务粒度 / service 边界 / 客观可验 的术语判据见 `glossary.md`。

体例: 判据 (可自检清单) → 正/反例 → worked example。规则带 `[S][M][C]` 档标记。

---

## 0. 一句话定位

计划阶段是给 worker 的**契约**, 不是给 reviewer 的弹药。它的产物决定下游一切: AC 写不清 → 测试无从断言; task 拆不好 → worker 上下文爆掉; 写路径标不准 → 并发互相覆盖。**质量靠这一步预防, 不靠事后审查 (信条 2)。**

---

## 1. 复杂度判定 (写进 task-plan 顶部)

一句话定档, 判据见 SKILL §5 阶段 0 表与 `glossary.md` §4 (service 边界):

| 档 | 触发 | 计划详尽度 |
| --- | --- | --- |
| simple `[S]` | 单一改动、无状态机、单服务 | 一段话设计 + 1 个 happy-path 用例 |
| medium `[M]` | 多个 AC、单服务 | 标准 (design + task-plan + 每 AC≥1 用例) |
| complex `[C]` | 状态机/并发/多 AC, 或跨服务≥2 | 标准 + 负向用例 + 风险登记, 拆 DAG |

**不要用 complex 的全套套 simple。** 摩擦匹配复杂度。

---

## 2. AC (验收标准) 怎么写

AC 是整个 run 的真理来源——所有 task、所有测试都回指 AC。AC 写不好, 下游全垮。

**单条 AC 的质量栏 (缺一即重写):** `[S][M][C]`
1. **有稳定 ID:** `AC-001`、`AC-002`……全 run 唯一、不复用、不改号。
2. **可观测:** 描述的是"系统对外能观测到的行为/状态", 不是内部实现 ("调用了 X 函数" ✗)。
3. **可机械验证:** 能落成至少一条可机械判定的断言 (客观可判定判据见 `glossary.md` §1)。
4. **单一条款:** 一条 AC 只讲一件可独立判真假的事; 含"并且/或者"的拆成多条。
5. **含口径:** 边界/异常路径写明期望 (不是只写 happy path)。

**好/坏 AC 对照:**

| ✗ 坏 AC | 病征 | ✓ 好 AC |
| --- | --- | --- |
| "登录要安全" | 不可观测、不可验证 | `AC-003: 连续 5 次密码错误后, 第 6 次返回 423 且 30 分钟内拒绝该账号登录` |
| "验证码功能正常" | 模糊, 无口径 | `AC-002: 提交错误验证码时, 登录接口返回 {ok:false, reason:"captcha_invalid"}` |
| "调用 generate_captcha()" | 描述实现非行为 | `AC-001: 请求验证码返回一张含 5 位数字的图片, 且服务端存有对应 token` |
| "性能要好并且界面友好" | 双条款 | 拆成 AC-perf 与 AC-ux 两条 |

---

## 3. design.md 必备章节

简明设计, **不写任何防伪/对抗机制** (那是已被否决的旧范式)。

**章节清单 (`[M][C]` 必备, `[S]` 可压成一段话):**
1. **目标与范围**: 一句话目标 + 明确"不做什么"(防 scope 蔓延)。
2. **AC 列表**: 全部 AC 带 ID (即 §2 的产物)。
3. **关键设计决策**: 选了什么方案、为什么、放弃了什么备选 (每条 1–2 句)。
4. **数据/接口/状态**: 涉及的数据结构、对外接口 surface、状态机 (有则画一张极简图)。
5. **风险登记** `[C]`: 触及控制面/安全/迁移/不可逆的点, 标 `risk: high`。
6. **(多服务)** 契约概览, 详见 `service-contracts.yaml`。

**反例:** design.md 写成需求复述 (没决策)、或写成实现代码 (越俎代庖 worker)、或塞防伪/快照/attestation 机制 (旧范式残留, 删)。

---

## 4. 任务拆分 (粒度 + DAG)

粒度判据见 `glossary.md` §5。这里给拆分**方法**与 **DAG 范式**。

**拆分自检 (每个 task 都要过):** `[M][C]`
1. 单一职责, 一句话说清产出 (无"并且")。
2. `allowed_write_paths` 用**具体前缀目录**, 不用裸 `**` (裸 `**` → 冲突保守串行, 见评审 F3)。
3. 可并行的 task 之间**写路径不重叠** (相交判定见 `loop_engineering/scheduling/path_overlap.py:path_globs_overlap`)。
4. `depends_on` 只连**真实数据/产物依赖**, 不为"我觉得该先做"加假依赖 (假依赖伤并发)。
5. 改控制面/迁移/lockfile/codegen 的 task 标 `exclusive: true` (它不与任何 task 同批)。
6. `depends_on` 不成环。

**DAG 范式 (常见好形状):**
- **扇出-汇聚:** 几个无依赖的叶子 task 并行 (写路径互斥), 一个汇聚 task 依赖它们。例: T01 验证码生成 ∥ T02 校验接口 → T03 登录接入 (依赖 T01,T02)。
- **管道:** 数据格式/契约先行 task → 消费它的 task。契约 task 往往是依赖根。
- **反范式:** 把本可并行的 task 串成一条链 (加了假依赖); 或所有 task 全标 exclusive (退化为纯串行, 丢掉并发收益)。

---

## 5. task-plan.yaml 主契约

schema 以 `loop_engineering/schema/task_plan.py` 为参考。每个 task 必含: `id`, `title`, `allowed_write_paths`, `depends_on`(可空), `acceptance_refs`, `exclusive`, `risk`, `tests`。

```yaml
complexity: complex
tasks:
  - id: T01
    title: 验证码生成与 token 存储
    allowed_write_paths: [src/auth/captcha/**, tests/auth/captcha/**]
    depends_on: []
    acceptance_refs: [AC-001]
    exclusive: false
    risk: normal
    tests:
      - id: T01-CASE-001
        scenario: 请求验证码返回含 5 位数字的图片且服务端存有 token
        checks: ["ok == true", "len(digits) == 5", "token_stored == true"]
  - id: T02
    title: 验证码校验接口
    allowed_write_paths: [src/auth/verify/**, tests/auth/verify/**]
    depends_on: []
    acceptance_refs: [AC-002]
    exclusive: false
    risk: normal
    tests:
      - id: T02-CASE-001
        scenario: 正确验证码通过校验
        checks: ["ok == true"]
      - id: T02-CASE-002
        scenario: 错误验证码被拒并给出原因
        checks: ["ok == false", "reason == 'captcha_invalid'"]
  - id: T03
    title: 登录流程接入验证码校验
    allowed_write_paths: [src/auth/login/**, tests/auth/login/**]
    depends_on: [T01, T02]
    acceptance_refs: [AC-003]
    exclusive: false
    risk: high          # 触及鉴权控制面
    tests:
      - id: T03-CASE-001
        scenario: 验证码正确时允许进入密码校验
        checks: ["captcha_passed == true"]
      - id: T03-CASE-002
        scenario: 连续 5 次密码错误后锁定 (负向, 控制面必备)
        checks: ["status == 423", "locked == true"]
```

---

## 6. 计划自检 (返回前必跑; 完整实现见 `loop_engineering/checklists/plan_check.py:check_plan`)

`[S][M][C]`:
- [ ] 每个 AC 至少映射 1 个 task 和 1 个测试用例。
- [ ] 每个 task 字段齐全 (§5 列表)。
- [ ] 可并行 task 写路径不重叠。
- [ ] `depends_on` 不成环。
- [ ] `[C]`/状态机/控制面 task 至少 1 个负向用例。
- [ ] (多服务) 每契约 provider+consumer 都有 task, 每契约 ≥1 集成用例。

不过 → 自己修一次 → 仍不过升级 coordinator, **不要自循环**。

---

## 7. 红线

- 不把 task 拆得过大 (worker 扛不住) 或过碎 (徒增协调)——粒度判据见 `glossary.md` §5。
- 不发明对抗式门禁。计划是契约, 不是弹药。
- 契约是一等公民: 跨服务接口必须落 `service-contracts.yaml`, 不靠口头。
- 不在 design.md 写实现代码; 不替 worker 决定内部实现细节。
