# Adversarial Review Report — Loop Engineering 协作式范式当前工程

> 审查方法：adversarial-agent-team（Mode A，Claude Code 真独立 subagent）
> 审查日期：2026-06-26
> 被审目标：协作式范式的三份当前文档（共 ~920 行）
>   - `loop-engineering-collaborative-design.md`（设计）
>   - `loop-engineering-master-prompt.md`（自包含编排系统提示）
>   - `loop-engineering-prompts.md`（公共约定 + 5 角色 prompt）
> 审查规模：Standard（Pro / Con + assumption / feasibility / architecture 3 维度 + Arbiter + Scribe；未启 Cross-Examiner）
> 范围声明：旧版对抗式设计（`...detailed-implementation-design.md`）及两份历史评审报告中针对旧版的发现不在本次复审范围；它们已被 collaborative-design §9 逐条交代。

## Executive Summary

- **Target:** Loop Engineering 协作式范式（设计 + master prompt + role prompts 三份当前文档）
- **Decision:** `revise`（修订后可进入小范围 dogfood；当前文档不可直接进入实现）
- **Risk Level:** `high`
- **Confidence:** `high`（5 名独立审查员在多组发现上收敛，证据均可回原文核验）
- **Required Changes:** 4 项 blocker（去重后 4 处，均为局部结构缺陷，不需范式返工）
- **Mode:** A — 5 个真独立隔离 subagent（独立性真实，未做 Mode D 降级）

**一句话结论：** 协作式范式骨架成立——5 名独立审查员中无一人质疑"协作式 > 对抗式"的范式选择，§0.2 的威胁模型纠偏被普遍接受。问题集中在 4 处局部承重墙：跨服务 + exclusive 的 conflicts 逻辑矛盾、两层状态机同步协议缺位、"模型无关"宣称与兜底模式白名单缺位、key_diffs 汇总路径缺解析器。修复路径清晰、不动范式。

---

## Final Decision

**`revise`，而非 `accept`，也非 `block`。**

- **不是 accept**：4 个 blocker 来自 4 个互不可见的独立上下文，每条都有可回原文核验的证据。按 rubric "any blocker ⇒ block or investigate"，但本次偏离该映射——4 条 blocker 全是局部结构缺陷（逻辑 bug、文档措辞、缺解析器、缺状态同步矩阵），范式骨架不动。理由见 §Arbiter Reasoning。
- **不是 block（推倒重来）**：5 名审查员无一质疑范式本身。Pro 最硬的 P1（威胁模型纠偏）、P3（ready_frontier 候选两两冲突检测）、P4（注意力预算持续约束）无人实质反驳。Con C1 显式承认"诚实披露的软约束不算 con"——攻击的是 §0 措辞与 §0.3 自承认之间的指令冲突，不是软约束本身。

---

## Strongest Pro Case

**P1 / 范式纠偏是逻辑自洽的"问题消解"操作（high 置信）：**

> design §0.2：LLM worker 的真实失败是"幻觉出格式合规但没真做到"的产物，不是"构造伪证"；因此 hash 链、snapshot、attestation 防的是一个不存在的攻击者；保留"测试真跑 + 人看关键 diff"恰好覆盖真实威胁（hallucination）。→ §9 表格据此把旧版 80% blocker 标为"消解/变形/大幅缓解"。

这是一个合法的"范式换，问题消失"操作——前提是威胁模型判断正确。

**P3 / 唯一保留的硬机制是跨范式都成立的真 bug 修复：**

> design §3.2 `ready_frontier` 候选两两冲突检测是从旧版继承的真正并发安全修正，与信任无关，与范式无关。

**P4 / 注意力预算是真正的防退化机制：**

> design §1.2 给了一条持续设计约束："每加一个'需要人看'的环节前，先问能否降级为机制判定 + 异常上报。"多数类似设计倒在这里：开始轻，慢慢加 gate 直到回到对抗式。

## Strongest Con Case

**A2 / "模型无关" + "白名单是软约束" 叠加 → 兜底模式下白名单不存在（blocker，high 置信）：**

> design §0.3 自承认 Claude Code 下白名单是软约束；master-prompt §1 又宣称"模型无关、按宿主自适应"。两者叠加后，在纯 API 单上下文宿主（无 subagent 隔离）上白名单连"软"都谈不上，`allowed_write_paths` 退化为 prompt 请求；而设计把 §3.2/§3.4 的"代码覆盖"防线列为"唯一保留的硬机制"，其硬性恰恰建立在 `actual_writes` 越界检测上——这一项在兜底模式下完全来自同一上下文 worker 的自报告。范式最自信的防线，在最常见的部署形态下最薄。

**C2 / 跨服务 + exclusive 的 conflicts 算法自相矛盾（blocker，high 置信）：**

> design §11.1 升级后的 conflicts：`if a.service != b.service: return a.exclusive or b.exclusive` —— 任一 task 标 exclusive 就让跨服务也冲突，直接吃掉 §11 章首尾反复宣称的"跨服务默认并行 / 多服务让并发更好"。且 exclusive task 多半是控制面/迁移——这类 task 最需要并发收益却最不可能有测试覆盖来解锁 §3.4 放宽。

**AR2 / 两层状态机同步协议缺位 + 三份文档 task 态枚举不对齐（blocker，high 置信）：**

> run-state.phase（6+1 态）与 task.status（4 态）之间的同步协议未定义；ABORTED 时 active_tasks 中 running 的 task 是否同步翻 blocked 未说；watchdog 回收（running→pending）与 ABORTED 转换若并发触发谁先变无定义。更糟：master-prompt §5 阶段 3 把 task 写成三态（pending/running/complete），漏掉了设计的 `blocked` 态。

**F1 / key_diffs 汇总路径无解析器实现（blocker，high 置信）：**

> prompts.md §D 要求 worker 在 `summary.md` 末尾附 `key_diffs:` 段（markdown 内嵌 YAML 片段）；design §2.3 / master-prompt §4 都要求 coordinator 在收口阶段"汇总所有 key-diffs"。但三份文档没有任何一处定义这个从自由 markdown 中提取 YAML 段的解析器——schema、容错、解析失败处理全缺。设计自吹的"段必填非空是硬 gate"在 MVP 事实上无法触发。

---

## Key Findings

| Severity | Confidence | ID | Finding | Evidence | Recommendation |
| --- | --- | --- | --- | --- | --- |
| blocker | high | C2 | §11.1 conflicts 跨服务时 `a.exclusive or b.exclusive` 让 exclusive task 一刀切取消跨服务并行 | design.md:403-408, design.md:410, design.md:236 | 把 exclusive 限定为 service-local；或把"控制面/迁移"类全局排他单独建模为 run 级锁 |
| blocker | high | A2 | "模型无关" + "白名单是软约束" 叠加 → 兜底模式下白名单不存在 | design.md:42-44, master-prompt.md:3-4, master-prompt.md:28-29 | 删除"模型无关"措辞改为"在具备 subagent 隔离的宿主上"；或在兜底分支明写"此模式下无隔离" |
| blocker | high | F1 | key_diffs 嵌 markdown 末尾，coordinator 汇总无解析器实现 | prompts.md:144, design.md:130, master-prompt.md:110/126 | key_diffs 单独成文件（`tasks/<id>/key-diffs.yaml`）走纯 YAML；或严格围栏格式 + 解析失败降级路径 |
| blocker | high | AR2 | 两层状态机无同步协议；master-prompt task 三态与设计四态不对齐 | design.md:183-190, design.md:343-350, design.md:220-225, master-prompt.md:93 | 补"两层状态机同步矩阵"；master-prompt §5 阶段 3 三态改四态对齐 |
| high | high | C1 | §0 公共约定"只看 packet"强措辞 vs §0.3 软约束 的指令冲突 | design.md:42-44, prompts.md:15-16 | 改 §0 为可违反表述；或在 dispatch 前做 context_paths 物理裁剪 |
| high | medium | C3 | service-contracts.yaml diff 是权威源，但 worker 又自己写这个文件 | design.md:433, prompts.md:145, design.md:431 | contract surface 修改权收归 plan-amendment 路径 |
| high | medium | A1 | §0.2 "worker 没有这个意图" 是事实主张还是定义未区分 | design.md:31, design.md:36 | 改为"工作假设，非实证断言"；强意图压力场景升 unattended |
| high | high | A3 | "跨服务≥2 自动 complex" 未定义 service 边界 | design.md:91, design.md:471, design.md:379 | 给 service 判据（独立部署/契约/存储之一）；加 monorepo 分层不算多服务的反例 |
| high | medium | A5 | unattended 独立复跑通道在纯 API 模型宿主下不可建 | design.md:52, design.md:264, master-prompt.md:3 | 明写 unattended 前提：需宿主提供确定性命令执行环境 |
| high | medium | A7 | 兜底模式下"角色污染"未提，与 §0.4 artifact-first 初衷冲突 | master-prompt.md:29, design.md:26 | 明写兜底模式 hallucination 概率上调；建议仅 simple 档可用 |
| high | high | F2 | medium 档 ROI 拐点不利，simple 档比单 agent 慢 5× 但无对应质量收益 | master-prompt.md:243-253, prompts.md:7 | simple 档直接走单 agent 路径；明写 ROI 拐点档位 |
| high | high | F3 | `**` glob 下 path_globs_overlap 无法静态判定，保守 True 让多数 task 串行 | design.md:158-175, design.md:216, design.md:211 | MVP 约束 allowed_write_paths 不用 `**`；或给 coordinator 配 glob-expand 工具 |
| high | medium | F4 | 兜底模式下 watchdog 失去独立触发主体 | master-prompt.md:29, design.md:222, design.md:218-229 | §3.3 显式标注兜底模式下 watchdog 退化；或 MVP 仅多角色隔离模式提供 |
| high | medium | F5 | §11.3 集成测试需 compose 起服务 vs §11.5 "无新增环境依赖" 矛盾 | design.md:467, design.md:472, master-prompt.md:227 | MVP 集成测试限定为契约级（schema/类型/mock）；端到端列 post-MVP |
| high | high | AR1 | master prompt 自包含被 §11 红队 skill / §5 独立复跑通道依赖破坏 | master-prompt.md:3-4, master-prompt.md:230-232, design.md:247, master-prompt.md:237-238 | 显式标注外部依赖 + capability probe 失败语义；或承认"自包含 + 可选增强" |
| high | high | AR3 | 调度子系统跨三份文档被重复定义无接口契约 | design.md:191-216, design.md:231-238, design.md:218-229, master-prompt.md:96-102, prompts.md:40-41 | design 开 §3.5"调度子系统接口契约"；master/prompts 引用而非复述 |
| medium | high | C4 | "key_diffs 段必填非空" 硬 gate 在 hallucination 下退化成"段存在即可" | design.md:130, design.md:37, prompts.md:144 | 不称"硬 gate"，称格式 gate；高风险 task 强制走 §E 红队 |
| medium | medium | C5 | watchdog 阈值是建议值；无 run 级预算熔断 | design.md:222, design.md:229, design.md:362 | run-state 加 budget 字段；阈值落配置 |
| medium | medium | C6 | unattended 存在性校验逻辑未定义 | design.md:264, design.md:324 | 即使 MVP 不实现也要写最小契约（探测命令/判定字段/失败语义） |
| medium | high | A4 | watchdog 阈值 15/30/60 min 无依据 | design.md:222 | 给可调公式（p95 × 2）或明标"待真实数据校准" |
| medium | high | A6 | "客观可判定"等术语无操作定义 | design.md:109, design.md:62, design.md:167 | 加反例清单 + 结构化判据 |
| medium | medium | AR4 | prompts.md §0 与角色段冲突仲裁规则缺失 | prompts.md:14-23, prompts.md:60-63, prompts.md:165-173, prompts.md:7 | §0 顶部加优先级行；改 §0 时 grep 角色段同步 |
| medium | medium | AR5 | 单服务/多服务 conflicts 两个签名，实现会留死代码 | design.md:211-214, design.md:402-408, design.md:179 | 统一为 (service, path) 版；单服务 task `service` 默认 `default` |
| medium | medium | AR6 | 跨角色文件系统接口无契约文档 | design.md:266-288, design.md:233, master-prompt.md:196-205 | design §6 加"文件系统写者契约"段 |
| medium | high | F6 | unattended 在 MVP 双向锁死（无实现 + 拒绝切换） | design.md:258, design.md:262-264 | MVP 诚实标注不可用；给 semi-unattended 过渡档 |
| medium | medium | F7 | 多 repo 多服务在 MVP 边界撑不住 | design.md:472, design.md:471, design.md:379 | MVP 限定"多服务 = monorepo"；多 repo 降级为多个独立 run |
| low | medium | C7 | §8.6 "provider/consumer 一致" 无客观口径 | design.md:337, design.md:452-454 | 改为可判定表述（integration_cases 全绿 + provider/consumer 都有 complete task） |
| low | high | C8 | master-prompt 状态机图缺 ABORTED，三份文档 phase 枚举不对齐 | design.md:363, master-prompt.md:36, prompts.md:33-34 | 三份 phase 枚举字字对齐；master/prompts 状态机图补 ABORTED 边 |
| note | high | P6-drift | prompts.md §A 职责 #1 提到 "events 日志"，design §6 已删 events.jsonl | prompts.md:37, design.md:290 | 改为"run-state.json 与 artifacts 的唯一写者" |

---

## Dimension Reviews

### assumption
- **Summary：** 协作式范式的承重假设多数诚实标注，但 §0.2 把"worker 没有攻击意图"写成事实主张而非工作假设；最致命的是 §0.3 自承认白名单是软约束却与 master prompt §1 "模型无关"叠加，使兜底模式下白名单不存在（A2 blocker）。多个核心术语（"客观可判定"、"阻塞性歧义"、"关键 diff"、"service"）缺操作定义。
- **Notable findings:** A1（意图主张 vs 工作假设）、A2（blocker）、A3（service 边界）、A5（unattended 在纯 API 宿主不可建）、A7（兜底角色污染）。

### feasibility
- **Summary：** 整体范式比对抗式轻很多、simple/medium 单服务路径大概率可跑通；但多处"机制判定"在 MVP 里被默认已有实现——key_diffs 解析器（F1 blocker）、glob 重叠判定引擎（F3）、service-contracts diff（C3/F7）、集成测试环境（F5）。首次落地会撞上"声明了机制但没有实现"的墙。
- **Notable findings:** F1（blocker）、F2（ROI 拐点不利）、F3（保守串行）、F4（兜底 watchdog 失主体）、F5（compose 环境依赖矛盾）。

### architecture
- **Summary：** 三份文档职责分层清晰但存在多处隐性耦合与契约空洞——调度子系统跨三份文档被重复定义且无接口边界（AR3）；master prompt 自包含性被 §11/§4 的 skill 外部依赖破坏（AR1）；两层状态机同步协议未定义（AR2 blocker）；§0 公共约定与角色段冲突仲裁规则缺失（AR4）。
- **Notable findings:** AR1、AR2（blocker）、AR3、AR5（两套 conflicts 签名）。

---

## Disputed Points

**真实分歧保留，不强求共识：**

1. **多服务扩展是"概念正确但实现半生"还是"概念有问题"？**
   - Pro P7 立场：§11 的三条（跨服务默认并行、契约一等建模、集成测试前置）取向预防式，是正确的扩展。
   - Con C2/C3 + Feasibility F5/F7 立场：conflicts 跨服务+exclusive 矛盾、契约权威源由 worker 自写、compose 环境依赖与"无新增依赖"矛盾、多 repo 撑不住——MVP 多服务路径在多处不通。
   - **Arbiter 裁：** 概念方向正确（P7 成立），但 MVP 边界过度乐观（C2/F5/F7 成立）。修复 = 收缩 MVP 多服务范围到 monorepo + 修 conflicts 逻辑 + 把契约 surface 编辑权从 worker 收走，不需重设计。

2. **"诚实披露软约束" 是否足以替代机制？**
   - Pro P2 立场：§0.2/§0.3/§2.3/§8 显式承认软约束残余是工程诚实，比假装 gate 万能更可信。
   - Con C1/C4 立场：诚实披露是必要的但不够——§0 强命令措辞 + §0.3 软约束定位会诱导 worker 误判；"key_diffs 段非空"自封硬 gate 给人"已机制校验"错觉。
   - **Arbiter 裁：** 两者都对。诚实披露应保留（接受 P2），但措辞与封号要精确（接受 C1/C4）：软约束不要用硬命令式措辞描述；格式 gate 不要称硬 gate。

3. **§0.2 "worker 没有攻击意图" 是工作假设还是事实主张？**
   - Pro P1 当事实主张接受，但 open_question 中自承"实际部署 worker 失败分布需确认"。
   - Assumption A1 指出这是循环论证，RLHF/instruction-tuned 模型在压力下确有趋利性隐藏失败的实证文献。
   - **Arbiter 裁：** A1 成立。改写为"工作假设，非实证断言"，并明示强意图压力场景需升 unattended。

---

## Arbiter Reasoning

### 决策逻辑链

- **置信 high 的依据：** 4 个 blocker 来自 4 个互不可见的独立 subagent，证据均可回原文核验；多组发现收敛（"模型无关" 落不到兜底、多服务 MVP 半生、状态机同步缺位、关键路径缺解析器）——按对抗式审查纪律，独立收敛是高可信信号。
- **为何 `revise` 而非 `block`：** 5 名审查员中无一人质疑"协作式 > 对抗式"的范式选择；Pro 最硬的 P1/P3/P4 无人实质反驳。4 个 blocker 全是局部结构缺陷：
  - C2 是 conflicts 函数的逻辑 bug（几行代码）；
  - AR2 是状态机同步矩阵缺失（一节文档）；
  - A2 是文档措辞与兜底事实不一致（删/改一段话）；
  - F1 是 schema 选型（key_diffs 单独成文件）。
  
  修复路径清晰、不动范式骨架、不要求架构返工。按 rubric "blocker ⇒ block/investigate" 是默认映射，本仲裁偏离该映射并据此说明理由：blocker 的"局部性 + 可修复性 + 范式无关性"使 `block` 不恰当。
- **为何 `revise` 而非 `accept_with_conditions`：** 4 个 blocker 中有 2 个（C2、AR2）是确定性逻辑/协议缺陷而非措辞问题——C2 让 §11 章核心卖点（跨服务并行）失效，AR2 让任意 ABORTED 转换在并发下行为未定义。这类问题不能"带条件接受"，必须先修。

### Arbiter 新发现（审查员未提）

- **§0.2 的承重经验主张未被验证：** 整个范式的自信建立在"实际部署中 worker 失败分布以 hallucination 为主"这一经验判断上（Pro P1 open_question 自承）。三份文档没有任何一处给出该判断的依据（历史 run 数据 / 文献引用 / dogfood 报告）。若该判断在特定部署中不成立（如存在外部注入 / 供应链 / 恶意 subagent 风险），范式最自信的"砍掉 80% 旧版 blocker"论断就动摇。**建议在文档首次引入此主张处加一行"待 dogfood 数据验证"。**
- **§11.5 把 §11.2 的核心机制降级为人工：** §11 把"契约是一等公民 + 三层防漂移"作为多服务的核心卖点，但 §11.5 MVP 边界写"契约变更传播的自动标记可先在计划拍板时人工确认"——这等于把 §11.2 第 1 层（确定性 yaml diff 触发传播）降级成人工流程。第 1 层是确定性 diff，成本低，**应在 MVP 内就做成机制判定**，否则 §11 的卖点是空挂的。

---

## Required Changes

按优先级排序，进入实现前必修：

1. **修 C2 — conflicts 跨服务逻辑：** 把 `exclusive` 限定为 service-local（同 service 内独占一批）；或把"控制面/迁移"这类全局排他单独建模为 run 级锁，与 service 级 path 冲突分离。当前 `a.exclusive or b.exclusive` 让 §11 核心卖点失效。
2. **修 AR2 — 两层状态机同步：** 补一张"phase 转换 ↔ task.status 转换"同步矩阵，定义谁先写谁后写；尤其定义 ABORTED 时未交回 task 的最终 status 值，以及 watchdog 回收与 ABORTED 的竞争裁决（建议 ABORTED 优先，watchdog 之后只读）。master-prompt §5 阶段 3 的 task 三态改为四态对齐设计。
3. **修 A2 — 兜底模式白名单缺位：** 删除 master-prompt §1 "模型无关"措辞改为"在具备 subagent 隔离的宿主上"；或在 §3 兜底分支明写"此模式下 allowed_write_paths 为 prompt 级请求，无任何隔离；actual_writes 越界检测是唯一防线"。避免范式最自信的"硬机制"在最常见部署形态下退化为 worker 自报自比。
4. **修 F1 — key_diffs 解析器：** key_diffs 单独成文件（`tasks/<id>/key-diffs.yaml`）走纯 YAML；或在 §D 给出严格围栏格式 + 收口阶段解析失败的降级路径（视为该 task 未提交、退回 worker）。当前"嵌在 summary 末尾"的设计在第一次实跑就会卡住收口自检。

---

## Optional Improvements

非阻断，按收益/成本排序：

- **C3：** 把 contract surface 修改权从 implementation worker 收走，归 plan-amendment 路径；worker 触及 surface 必须返回 `plan-amendment-needed`，由 coordinator 在 PLANNING 期统一改 yaml。
- **C5 + A4：** run-state 加 `max_llm_calls` / `max_cost` 字段；watchdog 阈值落配置，初值标"待真实数据校准"。
- **C6 + A5：** 即使 MVP 不实现 unattended，也要把存在性校验的最小契约写下（探测命令、判定字段、失败语义）；明写 unattended 前提是宿主提供确定性命令执行环境，纯 API 模型宿主直接拒绝。
- **A3：** 给 service 判据（独立部署/契约/存储之一）；§1.1 加反例（monorepo 内分层不算多服务）。
- **A6：** "客观可判定"加反例清单（非客观 = 是否优雅/是否充分）；"阻塞性歧义"加非阻塞性反例；"关键 diff"加结构化判据（public surface / 控制流 / 行数阈值 / risk:high 文件）。
- **A7 + F4：** §3.3 显式标注兜底模式下 watchdog 退化为无；建议兜底模式仅 simple 档可用。
- **AR1：** master prompt §11/§12 显式标注外部依赖；skill 缺失时退化为内置最小红队 prompt；通道未建时拒绝切档（已有，需对红队缺位同样机制）。
- **AR3：** design 单独开 §3.5"调度子系统接口契约"：`ready_frontier` / `push_actual_writes` / `watchdog_tick` 三个函数的输入输出、调用方（仅 coordinator）、被调用方。master/prompts 引用此节而非各自复述。
- **AR5：** 统一 conflicts 函数签名（只写一份按 (service, path) 比较）；单服务 task `service` 默认 `default`。
- **F2：** simple 档直接走单 agent 路径（不开闭环）；明写 ROI 拐点档位（medium 起进 loop）。
- **F3：** MVP 约束 `allowed_write_paths` 不得用 `**`，或要求显式前缀目录，让 overlap 退化为前缀字符串比较；或给 coordinator 配 glob-expand 工具。
- **F5 + F7：** MVP 集成测试限定为契约级（schema/类型/mock）；MVP 多服务限定为 monorepo；多 repo 多服务降级为多个独立 run。
- **AR4：** prompts.md §0 顶部加优先级行（"§0 与角色段冲突以角色段为准"或反向）；改 §0 时 grep 角色段同义措辞同步。
- **AR6：** design §6 加"文件系统写者契约"段（单写者 + temp+rename 原子读 + coordinator 读 worker 产物前先查 task.status==complete）。
- **C4：** 不称 key_diffs "硬 gate"，称格式 gate；高风险 task 强制走 §E 红队，或要求 key_diffs 每条引用具体文件 + 行号范围。
- **C7：** §8.6 "一致" 改为可判定表述（每个 contract 的 integration_cases 全绿 + service-contracts.yaml 中所有 provider/consumer 都有对应 complete task）。
- **C8 + P6-drift：** 三份文档 phase 枚举字字对齐；master/prompts 状态机图补 ABORTED 边；prompts.md §A 职责 #1 "events 日志" 改为 "run-state.json 与 artifacts"（design §6 已删 events.jsonl）。
- **F6：** MVP 文档诚实标注 unattended 不可用；给 MVP 期 semi-unattended 过渡档（人离场 + 收口后人工验证 + 全量回归）。
- **Arbiter 新发现 2：** MVP 内把 §11.2 第 1 层（service-contracts.yaml diff 触发传播）做成机制判定，因为它是确定性 diff；不要降级为人工。

---

## Residual Risks

即使修订后仍存在：

- **范式承重经验主张未验证：** §0.2 "worker 失败以 hallucination 为主"无数据支撑；若实际部署不成立（外部注入 / 供应链 / 恶意 subagent），范式自信部分动摇。需 dogfood 数据补足。
- **兜底模式整体偏弱：** 即使按 A2 修复措辞，单上下文扮演模式下 §0.4 artifact-first 初衷被打破，hallucination 概率上调，watchdog 失去独立触发主体——这是单上下文宿主的固有约束，文档只能诚实标注，不能消除。
- **MVP 多服务范围收缩可能令用户失望：** 真实多 repo 多服务需求在 MVP 内降级为多个独立 run，跨 repo 契约一致性需人工保证。
- **watchdog 与预算熔断参数缺标定：** 15/30/60 min 阈值、max_llm_calls 上限均无历史数据支撑，首次 dogfood 需校准。
- **"独立审查员"同模型串线：** 本评审自身也由同底层模型产出的 5 个 subagent 完成，共享盲点不能被结构消除；本报告的高置信收敛不等于"绝对正确"——若场景关键，需异模型或人工抽检。

---

## Open Questions

需文档作者/领域负责人决断：

1. **范式地基：** §0.2 "worker 失败以 hallucination 为主" 这一经验判断是否有 dogfood 数据/文献支撑？还是基于直觉？若未验证，是否应在文档首次出现处明标"工作假设"？
2. **多服务 MVP 边界：** 真实多 repo 多服务需求在 MVP 内的降级路径（多个独立 run）是否可接受？还是必须把 §11.4 多 repo 映射纳入 MVP？
3. **unattended 实际可用性：** 在用户的实际部署环境（Claude Code subagent / 纯 API 模型 / 其他宿主）下，"独立复跑通道"是否可建？这决定 unattended 档是真实能力还是空挂承诺。
4. **ROI 拐点：** 哪一档复杂度之上 loop engineering 的开销开始压倒"单 agent 直接写"的简单路径？simple 档是否应直接跳过 loop？
5. **收口 signer 责任：** §0.2 诚实披露"空签风险属人责任"，但 signer 是否在 UI 层被明示告知？若文档诚实而 UI 不诚实，§0.2 的诚实披露只在文档读者（不是 signer）那里生效。

---

## Appendix: Per-role Output Summary

| Role | summary 摘要 | findings | 最高严重度 |
| --- | --- | --- | --- |
| Pro | 范式纠偏自洽（P1）、硬/软诚实分级（P2）、ready_frontier 真 bug 修复（P3）、注意力预算防退化（P4）、trust_mode 升档存在性校验（P5）、三份传导保真（P6）、多服务预防式（P7） | P1–P7 | note（自承 P1 是接受前提） |
| Con | 三处真洞：§0 措辞 vs §0.3 自承认指令冲突（C1）、§11.1 conflicts 跨服务+exclusive 自相矛盾（C2 blocker）、§11.2 权威源由被信任糊弄者自写（C3）；多处自标软约束不算 con | C1–C8 | blocker（C2） |
| assumption | 最脆弱 A2（白名单跨宿主可移植性）；§0.2 意图主张未区分（A1）；service 边界未定义（A3）；unattended 在纯 API 宿主不可建（A5）；兜底角色污染（A7） | A1–A7 | blocker（A2） |
| feasibility | 整体可跑通 simple/medium 单服务；多处"机制判定"在 MVP 被默认已有实现——key_diffs 解析器（F1 blocker）、glob 引擎（F3）、compose 环境（F5）；ROI 拐点对 medium 不利（F2） | F1–F7 | blocker（F1） |
| architecture | 职责分层清晰但隐性耦合多：调度子系统跨三份文档无接口契约（AR3）、master prompt 自包含被 skill 依赖破坏（AR1）、两层状态机无同步协议（AR2 blocker）、§0 与角色段冲突仲裁缺失（AR4） | AR1–AR6 | blocker（AR2） |

---

*本报告由 adversarial-agent-team 协议生成（Mode A，Standard 规模）：5 个独立隔离 subagent 各自盲审 → 仲裁（绝不平均意见，blocker 压过 approval）→ scribe 渲染并核验。真实分歧已保留。*
