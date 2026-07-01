# Plan 拍板条件锚点化 (simple 免签) 设计方案

## 目标

把 `plan_signoff` 从"所有 run 无条件必经"改为**条件锚点**:当且仅当 run 是 `complexity=simple` 且未触发风险闸、且用户未强制要求门禁时,`plan_check` 通过后**自动接受计划并进入 IMPLEMENTING**,不停人拍板;其余 run(medium/complex,或命中风险闸)保留现有的人工 `plan_signoff` 停人。

该改动直接复刻 `wrap_up_signoff` 已经走过的演进(2026-06-28:从必经锚点降级为条件锚点):`submitWrapUp` 已用 `plan.tasks.some(t => t.risk===high || t.exclusive)` 决定"设 `wrap_up_signoff` 停人"还是"直接 advance 到 COMPLETE"。本方案把同构判据搬到 `submitPlan` 的 `plan_signoff` 那一步。

### 解决的真实痛点

用户对简单/低风险计划的拍板往往是橡皮图章,却要墙钟时间等人回来点一下"接受"。免签让人不再是 trivial 计划的瓶颈,同时用风险闸 + 诚实记账守住范式底线。

### 为什么不是"倒计时超时自动放行"(被否决的原方案)

原始想法是给 `plan_signoff` 加 30 分钟倒计时、超时自动实施。否决原因(分析结论):

1. **踩范式红线。** `plan_signoff` 是设计里唯一"只有人知道意图"的锚点(design §7),超时自动放行等于把"人已确认"悄悄替换成"人没来得及看",而这两者不是一回事。
2. **静默降级。** trust_mode 切档门明令"拒绝静默降级"(`gate.ts`),超时放行正是它反对的形态。
3. **诚实红线。** 把没被人冻结意图的计划记成"已签署",是范式定义的唯一致命失败(谎报,SKILL §2.5)。
4. **技术上不成立。** Claude Code 回合制:到 `plan_signoff` 时主 agent 已结束回合、进入休眠,没有任何进程在跑,无从"倒计时"。`human_anchors.ts` 注释明确:"状态机只校验 anchor 与当前 phase 的合法性,不负责通知或超时"。现有 watchdog 超时只服务 IMPLEMENTING 阶段活跃 tick 循环里的 worker task,与休眠等人的 plan 锚点不是一回事。

**规则驱动的条件免签**(本方案)与"人太慢了默认同意"(超时方案)本质不同:前者是"这个计划低风险,不需要人工冻结意图"的**判定**,并诚实记账;后者是掏空锚点。

## 当前行为(改动前基线)

- `Coordinator.submitPlan(plan)`(`packages/ssot-ts/src/runtime/coordinator.ts:305`):`plan_check` 通过 → **无条件** `setHumanPending(plan_signoff)`,停在 PLANNING 等人。
- `Coordinator.signoffPlan(accepted)`(同文件 `:378`):`accepted=true` → `clearHumanPending` + `advancePhase(IMPLEMENTING)`;`false` → 留 PLANNING,反馈写 `planning/signoff-feedback.md`。
- `guard_anchors` Stop hook(`packages/shared/src/hooks/guard_anchors/logic.ts`):`human_pending ∈ {plan_signoff, wrap_up_signoff}` → 放行(让主 agent 结束回合等人)。
- `RunConfigSchema`(`packages/ssot-ts/src/schema/run_state.ts:108`):`watchdog_timeout_min` / `max_retries_per_task` / `max_concurrency`,**无** plan 门禁开关。
- `PLANNING → IMPLEMENTING` 迁移本就合法(`transitions.ts:51`)。

## 非目标

- **不动 medium/complex 的 plan 拍板。** 它们仍无条件人盯(除非未来另开决策)。
- **不动 `signoffPlan` 的语义。** 人工签署路径原样保留,免签路径绝不复用它。
- **不改其余 3 个 hook**(`probe_and_gate` / `guard_paths` / `post_task_collect`)。
- **不引入倒计时/超时/调度器。**
- **不把免签做成跨复杂度可调。** 面固定为 simple(经用户 2026-07-01 决策)。
- **不改 `unattended` trust_mode。** 无人值守仍走它的独立复跑通道正门(§0.3,MVP 未建)。

## 判据规则 (唯一入口: `shouldAutoAcceptPlan`)

一个纯函数,`plan_check` 通过后被 `submitPlan` 调用。**全部条件同时满足**才免签,任一不满足即退化为现有 `plan_signoff` 停人:

```
免签(自动进 IMPLEMENTING) ⟺
    complexity == "simple"                    # 仅 simple (用户决策)
  ∧ config.require_plan_signoff != true       # opt-out 开关未强制回门禁
  ∧ ∄ task. risk == "high"                     # 风险闸①
  ∧ ∄ task. exclusive == true                  # 风险闸②
  ∧ ∄ planning/service-contracts.yaml          # 风险闸③(契约=跨服务,防御性兜底)
```

要点:

- **纯增益、不改既有停人路径:** 任一条不成立就退化为改动前行为(设 `plan_signoff`)。
- **契约闸判据 = `service-contracts.yaml` 是否存在**,与 `requiresIntegrationResults()` 同源。simple 单服务 run 正常无此文件;一旦存在说明判档失真,保守停人。
- **不涉及澄清默认复核:** simple 档整段跳过澄清,不存在"带 `default_if_unanswered` 继续的阻塞澄清问题需人在拍板时复核"这一层(那是 medium/complex 的顾虑)。选 simple-only 天然绕开。

函数签名(IO 留在调用侧,函数保持纯):

```ts
// packages/ssot-ts/src/state_machine/plan_auto_accept.ts
export function shouldAutoAcceptPlan(input: {
  complexity: Complexity;
  tasks: readonly Task[];        // 看 risk / exclusive
  requirePlanSignoff: boolean;   // config 开关
  hasServiceContracts: boolean;  // 调用侧传 fs.existsSync 结果
}): boolean;
```

## 落地点与控制流

**改动三处(方案:纯策略函数 + `submitPlan` 调用,与 `submitWrapUp` 同构):**

### (a) 新增纯函数

`packages/ssot-ts/src/state_machine/plan_auto_accept.ts`,即上文 `shouldAutoAcceptPlan`。契约文件是否存在等 IO 不进函数,由 `submitPlan` 侧探好再传布尔值。

### (b) schema 加配置字段

`packages/ssot-ts/src/schema/run_state.ts` 的 `RunConfigSchema` 增:

```ts
require_plan_signoff: z.boolean().default(false),
```

默认 `false` = 默认免签(opt-out);用户在 `run-state.config` 里置 `true` 即强制恢复门禁。

### (c) `submitPlan` 分叉

`coordinator.ts:331` 那段(`plan_check` 通过之后):

```
refreshPlanFile()
if (shouldAutoAcceptPlan({ complexity: state.complexity, tasks: plan.tasks,
                           requirePlanSignoff: state.config.require_plan_signoff,
                           hasServiceContracts: fs.existsSync(service-contracts.yaml) })) {
    写 planning/plan-auto-accepted.json     // 诚实记账,见下节
    state = advancePhase(IMPLEMENTING)       // 直接进实施,不设锚点
} else {
    state = setHumanPending(plan_signoff)    // ← 现有行为,原样保留
}
refreshStateFile()
```

**关键不变量:**

- 免签路径**绝不**调 `setHumanPending`,也**绝不**复用 `signoffPlan`(那是"人已签"语义)。
- 不满足免签 → 完全走现有 `plan_signoff` 老路,零回归。
- `signoffPlan` 本身不动;免签的 run 已在 IMPLEMENTING,若有人再跑 `signoff-plan` CLI,现有 `phase !== PLANNING` 守卫自然报错。
- `PLANNING → IMPLEMENTING` 合法(`transitions.ts:51`),plan 已 `this.plan = plan`,advance 前提满足。

## 诚实记账与呈现 (免签 ≠ 已签)

整个方案的正当性系于此:**免签的 run 绝不能被记成"人已拍板"**——否则就是范式定义的唯一致命失败(谎报)。

### (a) 独立标记文件 (审计真相)

Coordinator 免签时写 `runs/<id>/planning/plan-auto-accepted.json`:

```json
{ "auto_accepted": true,
  "accepted_at": "2026-07-01T...Z",
  "reason": "complexity=simple 且未触发风险闸(无 risk:high / 无 exclusive / 无 service-contracts)",
  "criteria_snapshot": { "complexity": "simple", "require_plan_signoff": false,
                         "has_high_risk": false, "has_exclusive": false, "has_contracts": false } }
```

- 与 `signoff-feedback.md`(人拒绝时反馈)**分属不同文件、不同语义**,绝不复用。
- 后续任何人翻此 run,一眼看出"这份计划从未经人工冻结意图,是规则自动放行的"。

### (b) 呈现 + 回滚退路 (降低遗漏,非阻塞)

SKILL 指导主 agent 免签时**照样把计划摘要呈给人**(与拍板点同一份摘要),措辞明确区分:

> "这是 simple run,按免签规则我**已自动接受**计划并开始实施(**无人工签署**)。若要改,说一声,我回滚到 PLANNING。"

- **不停回合:** agent 继续 dispatch worker。人看得见接受了什么,可随时叫停。
- 回滚走现成的 `IMPLEMENTING → PLANNING`(合法迁移,`transitions.ts:53`),本质是 plan-amendment 快路径,状态机已支持,无需新机制。

### (c) 措辞红线

免签路径任何输出/日志**禁止**出现"已签署""已拍板""signed off";只用"自动接受(免签)""auto-accepted"。数据层(不设 `human_pending`、不碰 `signoffPlan`)已保证区分,措辞是再加一道。

## SKILL 提示词 + hook 协同

真实 run 的协调器是主 agent(由 `core/coordinator.md` 指导),SKILL 文本必须同步改,否则 TS 改了、提示词没改,主 agent 仍会停人拍板。

### (a) `core/coordinator.md` 改动 (操作层)

- **§2 阶段 2「→ 计划拍板(人盯点 1)」:** 加免签分叉——simple + 无风险闸 + config 未强制 → 免签(呈摘要 + 声明已自动接受、无人工签署 + 写 `plan-auto-accepted.json` + 直接进 IMPLEMENTING + 不停回合);否则设 `plan_signoff`(现有行为原样)。
- **§2 核心信条第 3 条**(人锚定质量 / 冻结意图):加限定注脚,不掏空原则——"(simple 低风险单一改动按规则免签、诚实记账;意图冻结锚点对 medium/complex 及命中风险闸的 run 保留)"。
- **§7 注意力预算表:** "计划拍板"从无条件"必须人盯"标注为**条件人盯**(simple 免签),与 wrap-up 当年降级的写法一致。
- **§末尾"停回合硬不变量":** 补一句——simple 免签**不是**停回合点(不设 `human_pending`,advance 后继续 tick 派发)。

### (b) hook 协同 (已核对: `guard_anchors` 无需改,且正向强化)

- 免签后 `submitPlan` 直接 advance 到 IMPLEMENTING。若主 agent 误想结束回合,`checkImplementingPhase` 发现"有 pending task" → **deny 并催"继续 tick 派发,不要结束回合"**(`guard_anchors/logic.ts:208`)。Stop 门禁天然挡住免签后的早停,方向一致。
- 其余 3 个 hook 与 plan 门禁无关,**零改动**。

### (c) 规范源文档 + changelog

- `docs/loop-engineering-collaborative-design.md` §1/§7 加方法论演进注(比照文件内 2026-06-28 那几条写法)。
- `changelog.md` 对应版本下记本次改动(CLAUDE.md 硬要求)。
- `docs/loop-engineering-master-prompt.md` / `docs/loop-engineering-prompts.md` 若引用"plan 必经拍板",一并加同款注脚保持一致(次要)。

## 测试策略

用 `npx bun test tests-ts/`(CLAUDE.md 指定工具链)。分三层:

### (a) 纯函数真值表 — `tests-ts/ssot/plan_auto_accept.test.ts`

- simple + 无风险闸 + config=false → **true**(唯一免签态)
- medium → false;complex → false(复杂度闸)
- simple + 某 task `risk:high` → false
- simple + 某 task `exclusive` → false
- simple + `hasServiceContracts=true` → false
- simple + `require_plan_signoff=true` → false(opt-out 开关)

### (b) Coordinator.submitPlan 分支 — `tests-ts/ssot/coordinator_plan_auto_accept.test.ts`

- simple 干净 run:submitPlan 后 `phase=IMPLEMENTING`、`human_pending=null`、`plan-auto-accepted.json` 落盘且 shape 正确、**断言 `human_pending` 从不为 `plan_signoff`**(防误标反向断言)。
- simple + `require_plan_signoff=true` → 停在 `PLANNING` + `plan_signoff`(回归保护:开关能拉回门禁)。
- simple + risk:high task → `plan_signoff`(风险闸生效)。
- **medium run → `plan_signoff`**(关键回归:非 simple 老路径零改变)。
- simple 但 `plan_check` 失败 → 写 `plan-check-failures.json`、**不免签、不设锚点**(免签只在 check 通过后发生)。

### (c) schema + hook 回归

- `schema_run_state.test.ts` 补 `require_plan_signoff` 默认 false、可 round-trip true。
- `guard_anchors.test.ts` 补一例:simple 免签后进 IMPLEMENTING、有 pending task → Stop **deny 催继续**(确认新流程落到既有分支,不早停)。

### 跨宿主说明

判据活在 TS SSOT + SKILL 文本,不落在 CC/OC 某个 binding,故本特性无 CC/OC 决策分叉需要一致性测试;`guard_anchors` 是共享层,CC/OC 复用同一份,已被现有 binding 测试覆盖。

## 风险与权衡

- **降低了 plan 锚点的普适性。** 换来 simple run 的人体工学。守住底线的三道机制:复杂度闸(仅 simple)+ 风险闸(risk/exclusive/契约一票否决)+ opt-out 开关(purist 可全恢复)+ 诚实记账(绝不谎报为已签)。
- **默认改变对所有安装者生效。** 用户选了 opt-out(默认开),意味着 install 后 simple run 默认免签。`require_plan_signoff:true` 是明确退路,需在文档/README 中说明。
- **回滚窗口。** 免签后 agent 立即开始 dispatch,人读到通知时 worker 可能已起跑。回滚(IMPLEMENTING→PLANNING)是现成能力,代价是丢弃已起跑 task 的部分工作——对 simple(1–2 task)可接受。
