# 实施阶段 craft 标准 (IMPLEMENTING)

> 适用角色: `implementation-worker`。每 task 分发一个, 隔离上下文, 实现 single task。
> 本标准回答: 测试怎么写、"tests_green"算什么、key-diffs 里什么算"关键"、什么时候该 amend 而不是硬做。
> 测试用例如何从 checks 落地见 `test-design-standard.md`; 关键 diff / 任务粒度判据见 `glossary.md` §3 / §5。

体例: 判据 → 正/反例 → 边界规则。规则带 `[S][M][C]` 档标记。

---

## 0. 一句话定位

你只实现**一个** task, 只看你的 packet。你的产物 (test-results / summary / key-diffs) 会被 coordinator **信任** (软约束)——正因如此, **谎报是这个范式唯一致命的失败**。做不到就上报, 一个假绿比一次诚实上报危险得多。

---

## 1. 测试怎么写 (框架无关约定)

`test-design-standard.md` 给了"测什么"; 这里给"怎么写得让别人/未来的你看得懂、跑得动"。

**单个测试的质量栏:** `[S][M][C]`
1. **命名自解释:** 测试名 = 场景, 如 `test_wrong_captcha_rejected`, 不叫 `test_2` / `test_case_b`。
2. **一测一断言点:** 一个测试只验一个 scenario 的 checks; 不把三个 scenario 塞进一个测试函数。
3. **可独立运行:** 不依赖其它测试的执行顺序、不依赖外部可变状态; 需要的前置自己 setup。
4. **断言对齐 planned checks:** 测试里断言的字段/值, 与 planned `checks` 一一对应 (`reason == 'captcha_invalid'` → 测试断言同一字段同一值)。
5. **跟随仓库既有测试风格:** 框架 (pytest/junit/...)、目录、fixture 用法跟现有代码一致, 不自带一套。

**反例:** 测试名 `test_login`; 一个函数里断言 5 个不相干的事; 用 `sleep` 等时序; 断言 `assert result` (没说断言什么)。

---

## 2. "tests_green" 的操作定义

`tests_green: true` 意味着 (全部满足才可填 true): `[S][M][C]`
1. 本 task 所有 planned 用例都有对应测试, 且这些测试**真的被运行过**。
2. 运行结果**全部通过** (退出码成功 / 测试框架报 0 失败)。
3. 没有被 skip / xfail 掩盖的 planned 用例 (skip 一个 planned 用例 = 该用例未覆盖, 不能算绿)。

**反例 (这些都不是真绿, 填 true 即谎报):**
- 只跑了 happy 用例, 负向用例没写就报绿。
- 用 `@skip` 跳过跑不通的用例再报绿。
- "我觉得应该能过" 但没真跑。

**注意:** `actual_writes` (实际写了哪些文件) **不要你报**——coordinator 从 git diff 自采 (`loop_engineering/scheduling/actual_writes.py:collect_actual_writes`), 故越界检测独立于你的诚实, 你不必也不应自报写入清单。

---

## 3. key-diffs 里什么算"关键" (关闭评审 C4)

key-diffs 是收口时人**必须**看的那几处改动。判据见 `glossary.md` §3, 这里给落地要点。

**`tasks/<id>/key-diffs.yaml` (纯 YAML 独立文件), 每条 = `{file, change, why, risk}`:** `[S][M][C]`
- 只列**关键** diff (命中 `glossary.md` §3 判据 1–6 之一): 改了对外契约/控制流/数据格式/高风险路径/依赖/大块逻辑。
- `risk: high` / `exclusive` 的 task **此文件必填非空且可解析**, 否则视为未提交退回 (`loop_engineering/checklists/key_diffs_gate.py:validate_key_diffs_submission`)。
- 不要把每个文件、每处改名、每行注释都列进来——全列等于没列 (制造噪音, 淹没真关键项)。

**示例:**
```yaml
- file: src/auth/login/flow.py
  change: 登录流程在密码校验前插入验证码校验门, 失败直接返回不进入密码分支
  why: AC-003 要求验证码先于密码校验
  risk: high
- file: src/auth/login/lockout.py
  change: 新增连续失败计数与 30 分钟锁定
  why: AC-003 锁定口径
  risk: high
```

**反例:** 列了 `change: 改了变量名 i 为 idx`、`change: 加了空行` —— 非关键, 删。

---

## 4. amend vs 硬做 (发现计划错了怎么办)

**判断边界:** `[M][C]`
- planned 用例**不可执行**或**本身错了** (口径与 AC 矛盾、断言指向不存在的字段) → **不要硬做、不要偷改 checks**, 返回:
  ```json
  { "status": "plan-amendment-needed", "reason": "...", "touched_acceptance_refs": ["AC-002"] }
  ```
  **必须声明触及的 AC** (coordinator 据此确定性回滚相关 task, 见 `loop_engineering/amendment/rollback.py:compute_rollback`)。
- task **过大** (一个 worker 持不住上下文) → 返回 `task-needs-split`, 不硬塞。
- 只是实现细节卡住 (某库用法不会) → 自己查/试, **不**走 amendment (这不是计划的错)。

**自检口诀:** "是计划/契约错了, 还是我实现卡住了?" 前者上报回 PLANNING, 后者自己解决。改 AC 验收语义的才惊动人, 纯实现修正不打扰。

---

## 5. 产物三件套 (返回前自检)

`[S][M][C]`:
- [ ] `tasks/<id>/test-results.yaml`: `tests_green` 真实, cases 只填三固定字段。
- [ ] `tasks/<id>/summary.md`: ≤1200 字, 说清做了什么、关键决策。
- [ ] `tasks/<id>/key-diffs.yaml`: 只列关键 diff, 四字段齐全 (high/exclusive 必填非空)。
- [ ] diff 全在 `allowed_write_paths` 内, 没动其它 task 的写路径。
- [ ] 每个 `acceptance_ref` 有对应测试。

不过 → 自己修一次; 仍不过升级 coordinator。

---

## 6. 红线

- 不擅自删除/弱化/改名 planned 用例或其 checks (走 amendment, 不偷改)。
- 不扩 scope, 不写 `allowed_write_paths` 外的文件。
- 不谎报 `tests_green` (做不到就上报)。
- 不写 `run-state` / events / 别的 task 目录。
- 不通读整个仓库, 只读 packet 与 context_paths。
