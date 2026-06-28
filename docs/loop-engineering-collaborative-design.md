# Loop Engineering 协作式开发设计

更新时间: 2026-06-27

> 本文档取代 `loop-engineering-detailed-implementation-design.md` 的**对抗式**范式。
> 旧版把"如何让 LLM 可靠开发"(质量问题)建模成了"如何在不可信参与方间获得防篡改证据"(安全问题),
> 用零信任 + 防伪 + 多轮对抗的重武器去打质量问题,导致大量时间和上下文耗在 agent 与门禁的相互对抗上。
> 本版换成**协作式**范式:质量靠预防,门禁是自检清单,人在两个关键点锚定判断。
> 与旧版的逐条关系见 §9。

## 设计原则

1. **协作 > 对抗。** coordinator、worker、人是会犯错的协作者, 不是互相提防的对手。不为"防 worker 作弊"付出结构成本。
2. **预防 > 检测。** 质量是生产出来的, 不是事后检验出来的。把投资放在清晰 AC、测试设计前置、好的任务分解、给 worker 足够上下文上; 而不是放在门禁、对抗审查、防伪证据上。
3. **人锚定质量。** 质量的锚是你在**计划拍板**和**收口验收**两点的判断, 不是一堆 agent 互审。其余环节自动, 不打扰你。
4. **门禁是自检, 不是裁判。** 每道门禁都是一组**客观可判定**的 checklist, 由做完的 agent 自核、人抽查; 不通过就同一 agent 就近修一次, 修不动才升级给人。绝不让两个 agent 互相否决、多轮返工。
5. **轻是默认, 重是按需。** 对抗式红队、独立复跑、无人值守强校验都存在, 但默认关闭, 仅在高风险或无人值守场景按需开启 (§4 / §5)。

## 0. 协作模型

### 0.1 参与方

| 参与方 | 职责 | 失败模式 | 兜底 |
| --- | --- | --- | --- |
| Coordinator | 编排、状态推进、给 worker 最小上下文、向人提问 | 编排失真 | artifact-first, 只读摘要不读长输出 |
| Worker (LLM) | 在隔离上下文内实现单个 task、写测试、跑测试 | **非对抗性"糊弄"**: 上下文不够时幻觉出格式合规但没真做到的产物 | 测试真跑 + 关键产物人抽查 |
| 人 (你) | 在计划与收口两点拍板 | 看漏 | 高风险时升档红队 (§4) |

### 0.2 worker 的真实威胁是"糊弄", 不是"攻击"

LLM worker 不会精心构造时序伪证、伪造 hash 链、规划绕过校验的攻击链 —— 它没有这个意图。它的真实失败是**幻觉出一个看起来合规的产物**。

**适用边界 (范式的前提, 明说不藏):** 上面这句"它没有这个意图"是整个协作式范式的**地基假设** —— worker 可信但会犯错。这个假设成立, 协作式才比对抗式划算; 假设破了, 整套设计 (含 §5 `unattended` 档 —— 它加的检测也只针对 hallucination, 不针对恶意) 都不适用。**何时假设会破:** worker 来自不可信第三方贡献、用了被投毒/越狱的模型、或运行在对抗性多租户环境 —— 此时 worker 可能真有恶意, 需要外部沙箱或回到对抗式隔离, 不要套用本方法论。所以 §0.3 删除防伪机制的理由, 准确表述是"**在 worker 可信的场景**, 对抗式是过度设计", 而非"对抗式总是过度设计"。把边界划清, 协作式反而更站得住。

由此决定防护手段:

- **防糊弄 (保留):** 关键命令的测试结果, worker 自己跑并提交; 收口时人看关键 diff。简单、便宜、够用。
  - **已知 trade-off (明说, 非漏洞):** worker 自报告"测试绿"作为 evidence 被接受 —— 这正是 hallucination 最可能落地点。这是协作式范式的有意识选择, 不是疏忽。兜底是 §2.3 收口时人看关键 diff, 不是测试结果的独立验证。若场景对 hallucination 零容忍, 升 `unattended` 档 (§5) 启用 coordinator 独立复跑。
  - **兜底本身也是软约束 (再明说一层):** §2.3 的"人看 diff"是 checklist 一项, signer 可以空打勾。为降低"不知看什么所以没看", 收口前由 worker 产出结构化 `tasks/<id>/key-diffs.yaml`、coordinator 汇总成 `wrap-up/key-diffs.md`, signer 看的是这份聚焦清单而非全量 diff。但它**降低遗漏, 不强制审阅** —— signer 空签的风险仍在, 属人的责任, 机制消除不了。协作式范式对 hallucination 的最终兜底就停在这里。(补注: §2.3 对 `risk: high` / `exclusive` task 把"`key_diffs` 文件必填非空"升级为硬 gate —— 那是**可机制校验**的部分; 但"人是否逐条审阅"仍是软约束, 机制能保证清单在、保证不了人真看了。硬 / 软边界要分清, 不笼统说"它是 gate"。)
- **防对抗攻击 (删除):** 密码学 hash 链、repo snapshot 时序绑定、runtime 写授权证明 —— 防的是一个不存在的攻击者, 成本真而收益假 (旧版审查 B1 已证明 Claude Code subagent 模型下这类隔离根本强制不了)。

### 0.3 信任边界用 tools 白名单, 不用防伪协议

worker 不该写的东西 (run-state、别的 task 的代码), 用 subagent 的 `tools` 白名单 + `allowed_write_paths` 限制即可。这是一行配置, 不需要 attestation schema、event 签名链那一整套。

**强制力边界 (明说, 不让读者误判):** 在 Claude Code subagent 模型下, `tools` 白名单与 `allowed_write_paths` 是**软约束** —— subagent 继承父会话工具配置, 旧版审查 B1 已证明这种隔离强制不了。所以"代码覆盖是真问题"的**真正防线不是白名单**, 而是三层事后检测:

1. §3.2 `ready_frontier` 候选两两冲突检测 (派发前, 基于声明 glob);
2. §3.4 `actual_writes` 越界检测 (跑完后, 由 coordinator 侧 git diff 采集而非 worker 自报, 抓声明外的越界写);
3. §2.3 收口 diff 检查 (人看, 最后兜底)。

白名单只是"让规矩的 worker 不手滑", 不拦"声明 glob 不准导致的越界"。读者别误以为它是强制隔离。**单上下文兜底宿主上更弱** (无 subagent 边界, 白名单连软约束都不是, actual_writes 自采也可能退化为自报自比) —— 见 master-prompt 运行模式 §3 / review-report A2; 那种宿主上代码越界的唯一可靠防线是收口 diff + 人。

注: "命令独立重放"性质不同于上述防伪协议 —— 它防 hallucination 而非 forgery, 默认档不需要, 但作为 §5 `unattended` 档的可选通道保留。MVP 不实现 (§7), 首次升 `unattended` 档前需补建。

### 0.4 artifact-first (保留)

worker 的长推理、长日志、命令输出写入 run 目录, 主 agent 只读摘要、状态和必要路径。这条与对抗无关, 纯粹是控制主上下文膨胀, 保留。

## 1. 主流程

```
CREATED
  → CLARIFYING      评估阻塞性歧义; 不单独停人 (带默认进 PLANNING); medium/complex 跳过须留 skip_basis 证据
  → PLANNING        单 agent 出设计+任务拆分+测试设计  →  你拍板
  → IMPLEMENTING    每 task 一个 worker: 写测试+实现+跑测试, 绿了就交
  → WRAPPING_UP     跑全部测试 + 你看关键 diff
  → COMPLETE
  ↘ ABORTED         任意 phase 均可由人显式放弃 (§8.1); 进入后 run 不再推进, 留档供回看
```

返工**就近**处理: task 内的问题在 task 内修; 只有当问题改变验收语义时才回到 PLANNING, 并让你知道 (回 PLANNING 时已并发 task 如何回滚见 §3.6)。不设独立的 REVIEWING 阶段 —— 审查降为按需 (§4)。

人介入只在**两处质量锚定**, 由 `run-state.human_pending` 标记 (方法论演进 2026-06-28: 删除 CLARIFYING 期的 `"clarification"` 独立停顿——澄清不再单独停人, 有阻塞问题也带默认进 PLANNING, 问题在计划拍板时一并呈现):

- **质量锚定** (两处, 必经, 设计原则 #3 所指; 有 AskUserQuestion 工具的宿主用它弹结构化提问框, 无则文本):
  1. **计划拍板** (PLANNING 末, `"plan_signoff"`): "设计、拆分和测试设计如下, 是否补充或修改?" —— 质量最大杠杆在这里; 一并呈现被默认处理的澄清点。
  2. **收口验收** (WRAPPING_UP 末, `"wrap_up_signoff"`): "全部测试通过, 关键改动如下, 是否接受?"

### 1.1 复杂度档位 (调摩擦, 不加官僚)

由 plan agent 一句话判定, 写在 `task-plan.yaml` 顶部, 不做独立 artifact 和 gate:

| 档位 | 澄清 | 任务 | 计划详尽度 | 红队 |
| --- | --- | --- | --- | --- |
| simple | 跳过 | 1–2 个 | 一段话 + 1 happy-path 测试 | 否 |
| medium | 至多 1 次 | 3–6 个 | 标准 | 否 |
| complex | 按需 | 拆 DAG | 标准 + 负向用例 + 风险登记 | 可按需 (§4) |

档位作用于**摩擦预算** (澄清次数、是否强制负向用例、是否允许触发红队), 不约束单个 task 内部实现 —— complex 计划里允许夹一两个简单 task, 反之亦然。

一个额外触发维度: **跨服务 ≥2 的需求自动判为 complex** (§11.5), 并强制要求契约登记与集成测试设计。

### 1.2 注意力预算: 人盯点分层

本范式把质量锚在人的判断上 (设计原则 #3), 因此**人的注意力是系统最稀缺的资源**, 会被分散稀释。当前需要人的点有五个: 计划拍板、收口看 diff、契约变更、risk 判定、complexity 判定。全部平摊给人, 短期可行, 长期每个点都看不仔细。

故分两层:

| 必须人盯 (判断不可机制化) | 可机制前移 (人只复核异常) |
| --- | --- |
| **计划拍板** —— 验收语义是否正确, 只有人知道意图 | **risk 判定** —— 规则自动标记 (命中控制面/安全/迁移/不可逆路径), 人只复核被标 high 的 |
| **收口验收** —— 整体是否接受, 含 `key-diffs.md` 逐条 (§2.3) | **complexity 判定** —— 规则给初值 (AC 数 / 服务数 / 任务数), 人只在边界 case 调整 |
|  | **契约变更** —— `service-contracts.yaml` diff 机制判定 (§11.2), 人不盯 |

取向: 把"需要人"的点尽量前移成"机制判定 + 异常上报", 只把真正需要人类意图判断的两点 (拍板、验收) 留给人。**新增任何"需要人看"的环节前, 先问它能否降级为"机制判定 + 只在异常时报人"; 能, 就不要再占用注意力预算。** 这是一条持续设计约束: 每加一个判断点都要过这道筛子, 否则注意力会被慢慢蚕食回对抗式那种"处处要盯"。

## 2. 自检清单

三组门禁, 每项都是**客观可判定** (有/无、绿/红、在范围内/越界), 没有"summary 是否充分""设计是否优雅"这类语义判断。做完的 agent 自核, 人抽查; 不通过 → 同一 agent 就近修**一次** → 仍不通过升级给人。**不触发 writer↔reviewer 多轮对抗。**

### 2.1 计划自检

- [ ] 每个 AC 至少映射一个 task 和一个测试用例
- [ ] 每个 task 有 `allowed_write_paths`、`depends_on`、`acceptance_refs`
- [ ] 可并行 task 的写路径不重叠
- [ ] `depends_on` 不成环

多服务 run 追加三项契约自检 (provider/consumer 都有 task、每契约 ≥1 集成用例、provider 改 surface 则同步更新 `service-contracts.yaml`), 见 §11.2。

### 2.2 任务自检

- [ ] 测试绿 (worker 自己跑的结果)
- [ ] diff 在 `allowed_write_paths` 内
- [ ] 该 task 的每个 `acceptance_refs` 都有对应测试
- [ ] 没有动到其它 active task 的写路径

### 2.3 收口自检

- [ ] 全部 task 测试绿
- [ ] 每个有关键改动的 task 已产出 `tasks/<id>/key-diffs.yaml` (**纯 YAML 独立文件, 非 markdown 内嵌段**, 每条 = `{file, change, why, risk}` —— 收口阶段 coordinator 直接解析、汇总为 `wrap-up/key-diffs.md` 给 signer, 不再从自由文本提取 YAML, 消除 review-report F1 的解析器缺口)。**分级, 硬 / 软分清:** `risk: high` 或 `exclusive: true` 的 task —— `key-diffs.yaml` **存在、可解析、且 `key_diffs` 非空**是**机制 gate**(文件缺失/为空/YAML 解析失败 → 该 task 视为未提交, 退回 worker, 不许进 COMPLETE); signer 对这些 task 在收口清单**显式签字**也强制, 但"是否真逐条看了"仍是软约束(机制能强制"必须签", 强制不了"真看了"—— 这步是人的责任, 见 §0.2)。普通 task —— `key-diffs.yaml` 可省, 收口清单显式注明"无关键 diff"即可(软约束)。即: 高风险 task 把"文件存在 + 可解析 + 非空"升级为机制 gate, "人是否审阅"诚实地留在软约束, 不假装机制能保证。
- [ ] scope 与计划一致 (无计划外的大范围改动)

多服务 run 追加一项集成自检 (所有契约的集成用例绿), 见 §11.3。

自检结果是一个简单记录, 不是裁决文书:

```json
{
  "checklist": "task-self-check",
  "task_id": "T01",
  "items": [
    {"check": "tests_green", "pass": true},
    {"check": "diff_within_allowed_paths", "pass": true},
    {"check": "all_acceptance_refs_have_tests", "pass": true}
  ],
  "all_pass": true,
  "on_fail": "same-agent-fix-once-then-escalate-to-human"
}
```

## 3. 任务分解与写路径隔离

这是**唯一保留的"硬"机制** —— 因为"多个 worker 并发改重叠文件互相覆盖"是真问题, 与信任无关。

> **本节 (§3.1–§3.7) 是调度与写路径隔离的唯一规范源 (review-report AR3 的轻量兑现):** master-prompt / prompts 只描述 worker 可观察的**行为**, 不复述 `ready_frontier` / `conflicts` / `watchdog` 的**算法**; 三处如有出入, 一律以本节为准。不建正式接口契约 (那是过度工程), 但定单一真相源 —— 改调度逻辑只改这里, 派生文档跟着指向。

### 3.1 极简 task-plan

```yaml
schema: loop-engineering.task-plan.v2
complexity: complex
tasks:
  - id: T01
    title: 实现澄清门校验
    allowed_write_paths: [src/clarification/**, tests/clarification/**]
    depends_on: []
    acceptance_refs: [AC-001, AC-002]
    exclusive: false        # 改控制面/迁移/lockfile 的 task 置 true, 独占一批
    risk: normal            # high = 控制面核心/安全/数据迁移/不可逆操作; high 的 task 在收口前自动触发红队 (§4)
    tests:
      - id: T01-CASE-001
        scenario: 合法 finder/critic 产物通过澄清校验
        checks: ["passed == true", "blocked_reasons == []"]
      - id: T01-CASE-002
        scenario: 被拒的 critic verdict 阻塞澄清
        checks: ["passed == false", "'clarification_not_approved' in blocked_reasons"]
```

对比旧版, 每个用例去掉了 `red_first`、`validation.method`、`assert_fields`、`expected_evidence` 这些防伪包装, 只留 `scenario` (测什么) 和 `checks` (断言什么)。worker 写测试去满足 `checks`, 跑绿了提交结果。**没有 red-first 时序证明, 没有 coordinator 独立重放。**

**`checks` 的判定语义 (定死, 否则"客观可判定"是空话):** `checks` 每条是一个**机械可判**的断言, coordinator 不做语义理解, 只按固定文法求值:

- **文法白名单:** 仅允许 `<lhs> <op> <rhs>` —— `lhs` 是 `test-results.yaml` 里该 case 输出的字段路径 (JSONPath 子集, 如 `passed`、`blocked_reasons`), `op` ∈ `{==, !=, in, not in, <, <=, >, >=}`, `rhs` 是字面量 (bool / 数字 / 字符串 / 数组)。不允许函数调用、表达式嵌套、自然语言。plan agent 写不出机械可判的断言 → 该用例不合格, 退回重写 (不是放行)。
- **case 输出 schema 固定:** worker 的 `test-results.yaml` 中每个 case **只准填固定字段** `{id, passed: bool, failure_reason: str}` —— `passed` 供 `checks` 求值, `failure_reason` 仅供人读。worker **不得自创字段**去迎合某条 `checks` (那等于让被测方定义判定口径, 又一个 hallucination 落点); coordinator 求值时只认 schema 内字段, 遇未知字段路径 → 判该 check 失败 + 告警。这样"测试绿"的判定权落在 coordinator 的机械求值, 不在 worker 的自由报告 (呼应 §0.2: 不让被测方经手判定数据)。

多服务场景下, task 还会增加 `service`、`provides_contracts`、`consumes_contracts` 字段, 跨服务的写路径隔离、契约建模与集成测试见 §11; 单服务 run 不涉及这些字段。

### 3.2 调度: ready frontier (保留旧版的并发安全修正)

task.status 四态:

- `pending` — 可被 ready_frontier 选中
- `running` — worker 已派出、尚未交回 (`active_tasks` 即此态集合)
- `blocked` — watchdog 二次回收或自检两次失败后由人接手, ready_frontier 永不选中
- `complete` — worker 交回且自检通过

调用方拿到 `ready` 后, 立刻把这些 task 的 `status` 从 `pending` 翻为 `running` 并入 `active_tasks`; worker 交回后, 自检通过则翻 `complete`, 自检失败则保持 `running` 由同一 worker 就近修一次 (§2)。watchdog 超时触发时 task 从 `running` 退回 `pending` 重派 (在 `tasks/<id>/logs/watchdog.json` 留 `timeout` / `crash` 事件记录, **不作为独立状态**); 二次 stale 翻 `blocked` (§3.3)。四态显式避免了「worker 在跑但 status 仍为 pending → 被 ready_frontier 重复派发」的竞态。

```python
def ready_frontier(tasks, active_tasks):
    ready = []
    committed = list(active_tasks)          # 已占用资源: active + 本批已选
    for task in tasks:
        if task.status != "pending":
            continue
        if not all(tasks[d].status == "complete" for d in task.depends_on):
            continue
        # 关键: 不仅和 active 比, 还要和本批已选候选两两比,
        # 否则同批写范围重叠的 task 会被一起派发并互相覆盖
        if any(conflicts(task, other) for other in committed):
            continue
        if task.exclusive and committed:
            continue
        ready.append(task)
        committed.append(task)              # 选入即占用
    return ready

def conflicts(a, b):
    return (path_globs_overlap(a.allowed_write_paths, b.allowed_write_paths)
            or a.exclusive or b.exclusive)
```

`path_globs_overlap` 无法静态判定时保守返回 True (默认串行)。这是本方案唯一需要谨慎的算法, 因为它防的是真实的代码覆盖, 不是想象的作弊。**故 MVP 把它列为唯一需要充分单测的算法** —— 至少覆盖: `a/**` vs `a/b.py` (前缀包含)、`*.py` vs `**` (单层 vs 递归)、`a/*.py` vs `a/b/c.py` (深度差)、否定模式、以及 "判不准就返 True" 的每条边界 case。它是唯一的硬正确性防线, 测试投入要与之匹配。

### 3.3 异常回收: task `running` 的 watchdog

ready_frontier 把 task 翻为 `running` 后, worker 可能因崩溃、超时、subagent 无响应而永不交回。若不回收, 该 task 永远卡在 `running`, 阻塞依赖它的后续 task。处置:

- **心跳 / 超时**: worker 派出时记录 `started_at`; 超过阈值 (**取自 `run-state.config.watchdog_timeout_min`, 默认 simple 15 min、medium 30 min、complex 60 min, 落点见 §6** —— complex task 正常耗时更长, 阈值要更宽, 否则会把还在正常工作的 worker 误判失联、反复重派) 未交回 → 写 `tasks/<id>/logs/watchdog.json` 一条 `timeout` 事件, 触发下面的回收动作 (事件本身不是状态, 状态仍为 `running`, 回收动作才把状态翻为 `pending`)。
- **回收动作**: task 退回 `pending`, 从 `active_tasks` 移除, 写一行 `tasks/<id>/logs/watchdog.json` 记录原因 (`timeout` / `crash` / `no_response`)。**同时给该 task 递增一个 `attempt` 序号** (回收即作废本次派发, 见下文迟到交回处理)。
- **重试策略**: 同一 task 默认重派 `run-state.config.max_retries_per_task` 次 (默认 1, 落点见 §6); 仍 stale → 升级给人, task 标 `blocked`, 不再自动调度。
- **整体推进**: 若 stale 占比过高 (**口径定死: 分子 = 当前发生过 ≥1 次 stale 的 task 数, 分母 = 总 task 数; 按 task 计不按次计 —— 一个 task 反复 stale 只算 1, 避免单个坏 task 把比例刷爆**) 超过 50%, 或关键路径上 task 反复 stale, 自动建议人转 `ABORTED` (§8.1) —— 系统环境异常时不要硬撑。

watchdog 只处理"worker 失联"这一类失败, 不替代 §2 自检 —— 自检是 worker 交回后的质量门, watchdog 是 worker 没交回时的存活门。

**迟到交回与文件级残留 (诚实声明):** "超时"不等于"已死" —— 被判超时回收的 worker 可能只是慢, 之后复活并交回。处置分两层:

- **状态层 (机制可堵):** coordinator 只认当前 `attempt` 的交回; 被回收的旧 `attempt` 迟到交回**直接丢弃**, 不用它推进状态。这挡住了"用一个已判死 worker 的结果推进 run"。
- **文件层 (机制堵不住, 承认残留):** 旧 worker 复活时若已写入它的 `allowed_write_paths`, 而重派的新 worker 也在写同一批路径 —— 这是 §3.2 极力避免的并发双写从时间维度漏入。宿主无可靠 cancel (强制终止 subagent) 能力时, 这个文件级双写**机制消除不了**, 最终兜底是 §2.3 收口 diff (人会看到异常改动)。这与 §8.1 "有意不提供 resume" 同类: 不为一个小概率窗口上 "每 task 一个 worktree 暂存合并" 的重基建; 真需要写隔离的多 repo 场景本就有 worktree (§11.4), 在那里自然解决。MVP monorepo 停在 "作废迟到交回 + 收口 diff 兜底 + 本残留显式在案"。

**计数独立**: watchdog 的"重派 1 次"与 §2 自检的"修一次"分别计数, 不共享额度。最坏情况一个 task 可经历 1 次 worker 失联重派 (watchdog) + 1 次自检失败修复 (§2) = 2 次 LLM 重试; 任一条先耗尽即升级给人, 不允许两条叠加到 3 次以上。

### 3.4 `actual_writes` 反馈环 (调度并发度校正)

§3.2 调度用的是 task 的**声明** glob, 保守 True 会把并发长期压低。task 完成时需要本次**实际写入**的 path 列表 `actual_writes` 来校正。

**采集来源 = coordinator 侧, 不经 worker (关键):** worker 交回后, coordinator 从 `git diff --name-only` (或 worker 派出前后的文件系统快照对比) 计算 `actual_writes`, **不让 worker 自报**。这样 §0.3 三层防线的第 2 层 (越界写检测) 真正独立于 worker 诚实 —— worker 即使谎报也无从经手这个数据。代价仅是 coordinator 多跑一条 diff 命令, 而 worker 反而少产一个字段、少一项自检。这是"预防 > 检测"的正确形态: 不靠劝 worker 诚实, 靠数据来源不经被测方。

**采集语义 (实现必须定死, 否则第 2 层防线无根基):**

- **base ref:** worker 派出**前**的工作树快照 (如 `git stash create` 留底, 或记派出前 HEAD + 暂存区状态); 交回后对该 base 求 diff。
- **越界按"写过"判, 不按"最终内容"判:** worker 先写再删、最终 diff 为空的路径**仍计入** `actual_writes` (它确实触碰过该文件) —— 故需包裹写操作或用 reflog/mtime 捕获, 不能只看最终 `git diff`。
- **跨 task 共享路径归最早写入者:** 同一路径被多 task 写时归**最早写入的 task**, 后续 task 再写它即越界。这也是 §3.2 conflicts 要在派发前拦住共享写的原因; 共享生成物 (如 lockfile) 应在计划期建模为 `exclusive` 或归一个 task 独占。

据此 coordinator 调整, 两个方向现在都安全:

- **收紧 / 告警 (主用途):** `actual_writes ⊄ allowed_write_paths` → 越界写, 收口标记 + 触发 §2.3 diff 复核。因数据来自 coordinator 侧采集, 这是 §0.3 软约束白名单拦不住的越界的**真实且不可被 worker 绕过**的检测点。
- **放宽 (次用途):** 某 task 实际只写了声明的子集时, 后续调度可放宽与它的 overlap 判定。actual_writes 既由 coordinator 采集, 放宽不再有"worker 谎报写得少"的风险。

**宿主能力前提 (诚实声明):** 上述独立性依赖宿主提供 git 或文件系统 diff 能力 (绝大多数开发环境都有)。**探测时机定死: run 启动 (CREATED) 时 coordinator 一次性探测 git/fs diff 能力, 写入 `run-state.capabilities` (`{git_diff, fs_snapshot}`, §6); 此后所有 task 的 `actual_writes` 采集路径据此固定, 不在每个 task 临时探测 —— 避免同一 run 内一会儿自采、一会儿自报的不一致。** 若探测到两种 diff 都没有, 回退到 worker 自报 `actual_writes` —— 此时第 2 层退化为软约束, 只能信任"声明的上界"而非"自报的实际"(谎报偏多更保守=安全, 谎报偏少错误放宽=危险, 故放宽只在该写区有测试覆盖时启用)。回退路径同样落在 `run-state.capabilities` (`git_diff: false`), 不要静默退化。

### 3.5 调度子系统接口契约 (预留, 见 review-report AR3; 未实现)

review-report AR3 指出: 调度子系统 (ready_frontier 算法、actual_writes 采集、watchdog 回收) 跨 §3.2–§3.4 与 master/prompts 被多处复述, 无单一接口契约, 易漂移。AR3 建议在此固化三个函数 (`ready_frontier` / `push_actual_writes` / `watchdog_tick`) 的输入输出、调用方 (仅 coordinator)、被调用方, 其余文档引用本节而非各自复述。**本节当前为预留占位, AR3 未实现** —— 调度语义以 §3.2–§3.4 为准; 启用 AR3 时在此收敛, 消除三份文档的复述漂移。

### 3.6 plan-amendment 的并发回滚 (回 PLANNING 时已并发 task 怎么办)

worker 发现某 planned 用例不可执行或本身错了, 返回 `{ status: "plan-amendment-needed", reason, touched_acceptance_refs: [...] }` —— **amendment 必须声明它触及的 `acceptance_refs`**。回 PLANNING 只修受影响的部分, 不重开整个计划。问题是: 此刻别的 task 可能已 `complete` 或在 `running`, 它们要不要跟着回滚?

判定**确定性、不打扰人** —— 复用计划自检已建立的 AC↔task 映射 (每个 AC 映射哪些 task 本就有索引), 反查即可:

- amendment 声明的 `touched_acceptance_refs` 与某 `complete` task 的 `acceptance_refs` **相交** → 该 task 降级回 `pending` 待重验 (它依据的验收口径变了)。
- 相交的 `running` task → 召回作废 (它的 packet 已基于旧计划, 继续跑是浪费), 修订后重派。
- **不相交**的 task → 完全不动 (它依据的 AC 没变)。

**`touched_acceptance_refs` 是 worker 声明, 漏报兜底 (明示软约束 + 保守扩围):** worker 是 LLM, 可能漏报间接影响的 AC, 而反查只能反查到它声明的 AC。故 coordinator 不只信声明: 回滚范围**保守扩到"声明 AC 所在 task 的全部 `acceptance_refs`"**—— amendment 改测试通常牵动同 task 的多个 AC, 把同 task 邻居 AC 一并纳入重验, 用低成本换漏报安全。仍可能漏掉**跨 task** 的间接影响 (超出声明能反查的范围) —— 这是诚实的软约束残留, 最终靠收口 diff + 人兜底, 机制消除不了。

只有当 amendment **改变验收语义** (不只是修测试假设, 而是改了 AC 本身的含义) 时, 才在修订后重新触发**计划拍板** (§1 人盯点 1); 纯测试设计修正不惊动人。这条规则把"回 PLANNING 后的状态 reconcile"从一个开放难题收敛成一次 AC 集合求交, 落在 §1.2"能机制判定的不塞给人"那一栏。

注: 这是 plan-amendment (轻量回访, 范围由 `touched_acceptance_refs` 界定) 与 §8.1 ABORTED (整 run 放弃, 有意不做 resume) 的分界 —— 前者范围可机制界定故做, 后者范围不可界定故不做。

### 3.7 两层状态机同步矩阵 (phase ↔ task.status)

run 有两层状态: run 级 `phase` (§6, 7 值) 与 task 级 `status` (§3.2, 4 态)。两者由**同一个写者 coordinator** 维护, 不存在多写者竞争; 但转换时序需定死, 否则 ABORTED 与 watchdog 并发等场景行为未定义 (review-report AR2)。

**对应关系 (task.status 仅在 IMPLEMENTING 有意义):**

| phase | 合法的 task.status 集合 | 进入 / 离开条件 |
| --- | --- | --- |
| PLANNING 及之前 | (无 task) | 计划冻结后建 task, 全部置 `pending` |
| IMPLEMENTING | `pending` / `running` / `blocked` / `complete` | 进入时全 `pending`; 离开 (→ WRAPPING_UP) 要求**无 pending/running/blocked**, 即全 `complete` |
| WRAPPING_UP / COMPLETE | 全 `complete` | — |
| ABORTED | 冻结当前快照值 (不再改写) | 见下 |

**coordinator 单 tick 内的转换顺序 (定死, 消除竞争):** 每个调度 tick 依次做: ① 先查人是否触发 ABORTED → 是则转 ABORTED 并**停止后续所有调度动作** (ABORTED 优先级最高); ② 再跑 watchdog 回收 (running→pending, 或二次 stale→blocked); ③ 最后跑 ready_frontier (pending→running)。**ABORTED 与 watchdog 的竞争由顺序 ①>② 裁定: 一旦 phase=ABORTED, watchdog 当 tick 起不再执行**, 已 running 的 task 不等待交回。

**ABORTED 时 task 的终态 (定死):** 转 ABORTED 时**不改写** task.status (保留快照: 那一刻是 `running` 就记 `running`, 是 `complete` 就记 `complete`)。语义由 phase=ABORTED 统一覆盖 (§8.1: run 不再推进、未交回 task 视为丢弃、已 `complete` task 产物保留)。即 task.status 在 ABORTED 下是**历史快照而非活动状态**, 不需要额外的 `aborted` task 态。

## 4. 按需红队 (可选)

对抗式审查不是流程的常驻阶段, 而是一个可调用的工具。两种触发:

- **人主动调用** (任何时候): 你说"这个改动风险高, 红队一下"即启动。
- **自动触发** (收口前): task-plan.yaml 中带 `risk: high` 的 task, 在 WRAPPING_UP 前自动启动一轮红队。`risk` 由 plan agent 在 PLANNING 期判定, 判据 = 改动命中控制面核心、安全、数据迁移、不可逆操作之一。

形态可直接复用 `adversarial-agent-team` skill。日常 simple/medium 需求不开。

> 自指示例: 你给**这份设计文档本身**开过两轮 adversarial 审查 —— 因为它是高杠杆的架构决策。这正是按需红队的正确用法; 而日常写一个功能不该每次都付这个成本。

## 5. trust_mode 档位

把"信任程度"做成运行时开关, 而不是设计期的信仰选择。同一套设计, 两档切换:

| 档位 | 适用 | 相对默认增加的"检测" |
| --- | --- | --- |
| `collaborative` (默认) | 你自己/盯着的团队用; 你会看计划和收口 | 无 |
| `unattended` | 无人值守、产出直达上线、无人逐个看证据 | coordinator 对关键命令独立复跑 (走 §0.3 保留的通道, **MVP 未实现**); 关键 task 强制按需红队; 收口加自动化全量回归 |

**升档只加"检测", 不改"预防"。** 预防 (清晰 AC、测试设计、分解、足够上下文) 在两档里都在。

**架构诚实性注:** "升档"在概念上是配置翻转, 但 `unattended` 档依赖的 coordinator 独立复跑通道是 §0.3 明确保留的可选基础设施, §7 MVP 不实现。**首次切 `unattended` 档前必须先把这个通道建出来, 不是纯配置切换。**

这条约束本身要落成 gate, 不能只写在文档里: **切换 `trust_mode → unattended` 时, 系统先做存在性校验** (探测独立复跑通道的 capability flag / 入口是否就绪), 不存在则**拒绝切换**并提示"独立复跑通道未建, 请先补 §0.3 保留通道", 而非静默切到一个没有检测能力的"假 unattended"。这是架构诚实性的最后一公里: "未建就不能切"由机制保证, 不靠人记得。

## 6. Run 目录与 Schema

```
runs/<run_id>/
  run-state.json
  input/requirement.md
  clarification/        # simple 档整段跳过; medium/complex 必有 questions.json
    questions.json      # finder 产出: 阻塞性问题(+默认) 或 空问题+非空 skip_basis(裁量跳过留证)
    answers.json        # (可选) 人在计划拍板时改了默认才写; 否则默认随 questions.json 走
  planning/
    design.md
    task-plan.yaml
    service-contracts.yaml   # 仅多服务: 跨服务契约登记 (§11.2)
    service-map.yaml         # 仅多 repo: service→worktree 映射 (§11.4)
  tasks/T01/
    test-results.yaml   # worker 跑测试 (coordinator 另从 git diff 采 actual_writes, §3.4)
    summary.md          # ≤ 1200 字
    key-diffs.yaml      # worker 填: 每条关键改动 {file/change/why/risk}; risk:high/exclusive 必填非空 (§2.3)
    logs/               # worker 长日志、命令原始 stderr、推理轨迹 (§0.4 artifact-first 落点)
  wrap-up/
    verification.json
    key-diffs.md             # coordinator 汇总各 task key-diffs.yaml 成 signer 清单, 收口必看 (§0.2 / §2.3)
    integration-results.json # 仅多服务: 集成测试结果 (§11.3)
```

去掉了旧版的 `events.jsonl` (hash 链)、`artifacts/index.json`、`runtime/` (attestation)、`verification/command-evidence/`。如需回看历史, 一个无 hash 链的简单追加日志即可, 不作为防伪 witness。

`run-state.json` 极简 (核心字段 + 两个可选机制字段):

```json
{
  "run_id": "20260626-001",
  "phase": "IMPLEMENTING",
  "complexity": "complex",
  "trust_mode": "collaborative",
  "human_pending": null,
  "active_tasks": ["T02", "T03"],
  "key_artifacts": ["planning/design.md", "planning/task-plan.yaml"],
  "capabilities": {"git_diff": true, "fs_snapshot": true},
  "config": {"watchdog_timeout_min": {"simple": 15, "medium": 30, "complex": 60},
             "max_retries_per_task": 1, "max_concurrency": 4}
}
```

`capabilities` 与 `config` 是**可选**字段, 缺省时各取下述默认, 不写也能跑 (保持极简):

- `capabilities` —— coordinator 在 CREATED 时一次性探测宿主能力写入 (§3.4): `git_diff` / `fs_snapshot` 决定 `actual_writes` 走独立采集还是回退 worker 自报。不预设 true, 以探测结果为准。
- `config` —— 运行参数的单一落点, 供 §3.3 watchdog 与 §3.2 调度引用, 改阈值只改这里: `watchdog_timeout_min` (按档位的超时分钟数) / `max_retries_per_task` (同 task 重派上限, 与 §2 自检"修一次"分别计数) / `max_concurrency` (单批 ready_frontier 并发上限)。缺省即示例中的值。

`human_pending` 取值为 `null`、`"plan_signoff"` 或 `"wrap_up_signoff"` —— 协作式核心字段: 系统只在这个值非空时把球交给你。两类非空值分别对应 §1 中人介入的两处质量锚定 (方法论演进 2026-06-28: 删除 `"clarification"`——澄清不再单独停人)。

仅当 `phase == ABORTED` 时, `run-state.json` 额外含两个字段 (定义见 §8.1): `aborted_at` (ISO 8601 时间) 与 `aborted_reason` (自由文本); 其它 phase 下这两个字段不出现在文件里, 避免误导。

`phase` 取值为 `CREATED` / `CLARIFYING` / `PLANNING` / `IMPLEMENTING` / `WRAPPING_UP` / `COMPLETE` / `ABORTED`。`ABORTED` 是唯一非正常终态, 任意 phase 均可由人显式放弃转入 (§8.1); 进入 `ABORTED` 后 run 不再推进 —— 不再调度新 worker、不再接受 signoff, `active_tasks` 中未交回的 task 视为丢弃, 已交回的 task 产物保留在 `tasks/<id>/` 下供回看。

## 7. MVP

最小闭环:

1. `run-state.json` + 极简状态机 (§1)
2. clarification (单 agent, 不单独停人; 产出 = 阻塞问题带默认, 或 medium/complex 裁量跳过的 skip_basis 留证) + 计划拍板
3. plan agent: 一句话复杂度判定 + `task-plan.yaml` + 测试设计
4. 三组自检清单 (§2)
5. ready frontier 调度 + 写路径隔离 (§3)
6. per-task worker: 写测试 + 实现 + 跑测试
7. 收口验收

可暂缓: 按需红队 (§4)、`unattended` 档 (§5)、多「需求」并行与 worktree (多个独立需求各一 run, 仅当真有 ≥2 并行需求时再引入)。

注意区分两个正交的"多": 多「需求」并行 = 多个独立需求各自一个 run; 多「服务」开发 (§11) = 单个需求横跨多个服务。多服务的 MVP 边界见 §11.5 —— monorepo 多服务在 MVP 内, 多 repo 暂缓。

## 8. 完成定义

一次 run 为 COMPLETE 当且仅当:

1. (若需) 澄清已得到回答或采用明确默认。
2. 计划自检通过, 且你已拍板。
3. 全部 task 自检通过 (测试绿、diff 在范围、AC 有测试覆盖)。
4. 收口自检通过, 你已验收。
5. `run-state.phase == COMPLETE`。
6. (仅多服务 run) 所有跨服务契约的 provider 与 consumer 一致, 集成测试绿 (§11.2–§11.3)。

无需 command-evidence 防伪、event hash 链完整、runtime attestation 这些旧版条件 —— 它们随对抗式范式一并退场。

### 8.1 中止定义 (ABORTED)

一次 run 为 `ABORTED` 当且仅当人显式选择放弃 (任意 phase 均可触发)。转入 `ABORTED` 后:

1. 不再调度新 worker, `active_tasks` 中 `running` 的 task 不再等待交回 (task.status 冻结为快照值, 不改写; watchdog 当 tick 起不再回收 —— 转换顺序见 §3.7)。
2. 已 `complete` 的 task 产物保留在 `tasks/<id>/` 下, 不删除。
3. `run-state.json` 中 `phase` 置 `ABORTED`, 附加字段 `aborted_at` 与 `aborted_reason` (自由文本)。
4. run 不进入 COMPLETE, 不产出可交付物; 仅作为历史记录留档。

**有意不提供 resume。** 半拉子 run 的状态恢复语义复杂 (已 `complete` 的 task 是否仍可信? 部分被改的文件怎么处理? 中途切换的上下文如何重建?), 复杂度收益不划算。若要继续同一需求, 开新 run, 把上一 run 的 `tasks/<id>/summary.md` 当作现成输入。**watchdog 自动建议转 ABORTED 的场景 (§3.3) 也走同一路径** —— 环境异常时承认死了, 而不是硬撑。

## 9. 与对抗式版本 (旧文档) 的逐条关系

换范式不是逃避旧版审查发现的问题, 而是让其中大部分**不再适用**, 同时**保留**真正的工程修复:

| 旧版审查 blocker | 在本版的处置 |
| --- | --- |
| 受信采集函数未定义 (防伪地基悬空) | **变形** —— 不再要求密码学受信采集; worker 自跑测试自报告 + 人抽查。"采集"问题仍在 (summary 怎么写、log 进不进 artifact), 但退化为普通工程问题, 无防伪要求 |
| gate 引擎是确定性代码还是 LLM 未定义 | **消解** —— 门禁是客观 checklist, 不做语义裁决 |
| events.jsonl actor 可伪造 / hash 链空窗 | **消解** —— 去掉 events 防伪定位 |
| §0.4 "自然隔离" 是事实性幻觉 | **消解** —— 改用显式 tools 白名单 (§0.3), 不声称自然隔离 |
| LLM 调用预算无熔断 / 对抗扇出爆炸 | **大幅缓解** —— 去掉多轮对抗 repair 和 4× reviewer; 自检就近修一次, 红队按需 |
| 状态机死状态、缺返工边 | **简化消解** —— 收敛到 6 个正常 phase (CREATED / CLARIFYING / PLANNING / IMPLEMENTING / WRAPPING_UP / COMPLETE; CLARIFYING 可跳过) + 1 个异常终态 ABORTED (§8.1); task 级另有 watchdog 回收 (§3.3); 就近返工 (§1), 无死状态 |
| `ready_frontier` 不查候选间冲突、引用未定义字段 | **保留修复** —— §3.2 候选两两冲突检测 + 定义 `exclusive`/`conflicts`/`path_globs_overlap` |

一句话: 旧版 80% 的 blocker 是"对抗机制自身的洞", 范式一换即不存在; 唯一的真正正确性 bug (并发候选冲突) 被继承保留。

## 10. 关键决策

1. 范式从对抗式 (零信任 + 防伪 + 多轮互审) 切换为协作式 (预防 + 自检 + 人在两点锚定)。
2. worker 视为会糊弄的协作者, 不是会攻击的对手; 防护用 tools 白名单, 不用防伪协议。
3. 门禁全部是客观 checklist, 不通过就近修一次再升级给人, 不做 agent 间多轮否决。
4. 测试是质量信号 (跑绿即可), 不是法庭证据 (无需 red-first 时序、独立重放)。
5. 唯一保留的硬机制是任务分解与写路径隔离, 因为代码覆盖是真问题。
6. 对抗红队与无人值守强校验降级为按需/可切档, 默认关闭。
7. 质量的最终责任在人在计划与收口两点的判断, 系统其余部分为之服务, 不替代之。
8. 多服务是协作式范式的扩展而非例外 (§11): 跨服务用 `service` 维度隔离 (默认并行)、契约一等建模 (防漂移)、集成测试前置 (是测试非对抗门禁); 三者皆预防式, 不退回对抗。

## 11. 多服务开发支持 (扩展; 单服务 run 不涉及)

本节是 §0–§10 协作式范式在多服务场景的扩展, 不是新范式。三条扩展全部预防式: 跨服务**默认并行** (更轻)、契约**一等建模** (防漂移)、集成验证是**测试非对抗门禁**。单服务 run 完全不读本节。

### 11.1 service 维度: 写路径隔离与并发 (扩展 §3)

task 增加 `service` 字段, 写路径空间从 `path` 升为 `(service, path)`:

```yaml
tasks:
  - id: T03
    service: auth
    allowed_write_paths: [auth:src/**, auth:tests/**]
    provides_contracts: [C-auth-token]
  - id: T04
    service: gateway
    depends_on: [T03]
    allowed_write_paths: [gateway:src/**, gateway:tests/**]
    consumes_contracts: [C-auth-token]
```

§3.2 的 `conflicts` 相应升级:

```python
def conflicts(a, b):
    if a.service != b.service:
        return False                           # 跨服务永不冲突: exclusive 是 service-local, 不跨服务独占 (C2 修复)
    return (path_globs_overlap(a.allowed_write_paths, b.allowed_write_paths)
            or a.exclusive or b.exclusive)     # 同服务内: path 重叠, 或本服务有 exclusive
```

效果: **不同服务的 task 天然可并行** —— 多服务让并发更好, 不是更难; 同服务内仍按 path 隔离。

**`exclusive` 是 service-local, 不跨服务独占 (C2 修复, 采纳 review-report 方案 a):** 上面 conflicts 跨服务分支返回 `False` —— `exclusive` 只独占**本 service 一批** (迁移/lockfile 静默本服务即可), 不阻塞其他服务的 task。这才兑现 §11 "跨服务默认并行 / 多服务让并发更好" 的卖点; 一个服务的 lockfile/迁移不再殃及独立服务。**饥饿**问题随之基本消失 (exclusive 只与同服务 task 竞争, 范围小)。**真正需要跨服务全局静默**的罕见场景 (如跨服务 schema 联动迁移) 不再由 `task.exclusive` 表达 —— 留待 post-MVP 引入显式 **run 级锁** (review-report 方案 b), 与 service 级 path 冲突分离建模; MVP 不做。

### 11.2 service-contracts.yaml: 契约一等建模 (防契约漂移)

多服务质量的真相在契约。planning 期产出 `planning/service-contracts.yaml`, 把每个跨服务接口显式登记:

```yaml
schema: loop-engineering.service-contracts.v1
contracts:
  - id: C-auth-token
    provider: auth
    consumers: [gateway, billing]
    surface: "POST /token → { access_token, scope }"   # API / 消息 / 共享类型
    acceptance_refs: [AC-007]
    integration_cases: [IT-001]
```

task 加契约关系字段 (`provides_contracts` / `consumes_contracts`, 见 §11.1)。

**契约变更传播 (核心机制, 是依赖边不是裁判):** 改了某 contract 的 provider task → 所有 `consumes` 它的 task 自动获得一条隐式依赖, 标记需重新验证集成。这把"下游没意识到契约被改"—— 也就是 §0.2 那个 hallucination 落点在多服务下最危险的升级版 —— 在 planning 期就暴露成显式依赖边, 而不是等集成时炸。

**"改了 contract" 的判定来源 (三层, 防自报漏报):** "provider 改了契约"由谁说? 不能只靠 provider task 自报 (worker 可能漏报, 又一个 hallucination 落点)。本方案定为三层:

1. **权威触发源 = `service-contracts.yaml` 版本 diff (确定性):** 契约是一等公民, 改契约**必须**先改这个文件; coordinator 对比前后版本, contract surface 有 diff → 权威判定"已变更", 触发传播。不依赖 worker 自报。
2. **辅助及早信号 = task 自报 `contract_changes`:** provider task 在 summary 声明 `contract_changes: [C-xxx]`, 用于在集成测试前就**及早**标记 consumer 重验; 与第 1 层不一致时以第 1 层为准 + 告警。
3. **兜底 = consumer 的 integration test:** 防"改了代码行为但没改 `service-contracts.yaml`"的声明外漂移 —— 由 consumer 覆盖该 contract 的集成测试 (§11.3) 抓住。

计划自检 (§2.1) 对多服务 run 追加三项:

- [ ] 每个 contract 的 provider 与所有 consumers 都存在对应 task
- [ ] 每个 contract 至少有一个 `integration_cases`
- [ ] provider task 若触及契约 surface, 同步更新了 `service-contracts.yaml` (否则按上面第 3 层兜底暴露)

### 11.3 两层测试: 单测 + 前置集成测试 (补回被误伤的集成验证)

| 层 | 验什么 | 谁跑 | 何时设计 |
| --- | --- | --- | --- |
| 单测 (§2.2) | 单服务内部行为 | task worker | task 的 `tests` |
| **集成测试 (新增)** | 跨服务契约 + 端到端场景 | 收口阶段 worker | planning 期前置, 挂在 contract 上 |

集成用例 (`IT-xxx`) 在 planning 期就设计, 挂在 contract 上。**它是测试不是 reviewer**: worker 跑、跑绿即可, 无独立重放、无对抗裁决。这正是上一版砍 merge-queue 时被误伤的"集成验证" —— 它是预防机制 (前置设计 + 真跑), 不是对抗门禁, 所以补回它不破坏协作式范式。

收口自检 (§2.3) 对多服务 run 追加:

- [ ] 所有 contract 的 `integration_cases` 集成测试绿

**集成测试红的返工路径 (不同于就近返工):** 跨服务集成失败通常**不能归因到单个 task** (是 provider/consumer 对契约理解不一致), "就近"没有"近"可归。故集成红 → **回 PLANNING 重审该契约** (而非回某个 task), 接 §11.2 契约变更传播: 重新核对 contract surface 与双方实现, 修订后按 §3.6 回滚规则重验所有 consume 它的 task。这是 §11.2 "契约是依赖边" 在收口阶段的兑现。

### 11.4 多 repo: service → worktree 映射 (轻量, 无防伪)

monorepo 下 §11.1 的 `service:path` 已足够。多 repo 时加一张映射表把 service 落到物理树:

```yaml
schema: loop-engineering.service-map.v1
services:
  auth:    { worktree: ../wt/auth }
  gateway: { worktree: ../wt/gateway }
```

这是旧版 worktree-binding 的轻量版 —— **只用于把 task 写操作定位到正确物理树, 去掉旧版的防伪 attestation**。集成测试需多服务同时在场: 收口阶段把相关 worktree 当前状态拉到一处 (或用 compose 起多服务) 跑端到端。这是本节唯一需要环境支持的部分。

### 11.5 复杂度识别与 MVP 边界

- **识别:** 跨服务 ≥2 的需求, plan agent 自动判定为 **complex** (§1.1), 强制要求 `service-contracts.yaml` + 集成测试设计。
- **MVP 边界:** monorepo 多服务先支持 (§11.1–§11.3, 纯路径与契约逻辑, 无新增环境依赖); 多 repo (§11.4) 暂缓到真有多 repo 需求再引入。契约变更传播 (§11.2) 的自动标记可先在计划拍板时人工确认, 自动化随后。
