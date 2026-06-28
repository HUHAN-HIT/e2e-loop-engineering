# 对抗式审查报告：Loop Engineering 详细设计与实施方案

> 审查方法：adversarial-agent-team（Mode A，Claude Code 真独立 subagent）
> 审查日期：2026-06-25
> 被审目标：`loop-engineering-detailed-implementation-design.md`（1735 行）
> 审查规模：Full（Pro / Con + 6 维度 + 交叉质询 + 仲裁）

## 执行摘要

| 项 | 结论 |
| --- | --- |
| 目标 | Loop Engineering 多 agent 闭环工程控制面设计文档（架构 + 实施方案，高杠杆、将驱动后续实现） |
| **裁决** | **revise（需修订；方向可行、路径清晰，但按当前文档不可进入实现）** |
| **风险等级** | **high** |
| **置信度** | **high** |
| 必修项 | 8 项 blocker 级承重墙（去重后 5 处核心 + 3 处工程缺陷） |
| 模式 | Mode A — 8 个真独立隔离 subagent + 交叉质询 + 独立仲裁（独立性真实，未做 Mode D 降级） |

**一句话结论**：这是一份有真实工程思考、骨架正确的设计稿，但把若干最关键的"在不可信参与方（LLM worker）下如何获得可信证据"的问题，留作了**文字承诺而非机制**。修订应集中火力于五处承重墙——独立采集、确定性 gate、状态机闭合、并发冲突闭合、调用量级预算——补齐后可进入小范围 dogfood 实现。

**信号强度说明**：9 条 blocker/high 来自 **7 个互不可见的独立审查员**，交叉质询标记出 **10 组收敛发现**（多个隔离上下文指向同一根因）。按对抗式审查纪律，独立收敛是高可信信号，故置信度判为 high。

---

## 最终裁决

**revise，而非 accept，也非 block。**

- **不是 accept**：单条头号议题（受信采集地基悬空）一旦不成立，文档的核心价值主张"消除自然语言声明完成"即降级为"换一个载体声明"。这一条就足以否决"据当前文档进入实现"，无论有多少 note/low 级 approval——blocker 压过 approval，不取平均。
- **不是 block（推倒重来）**：文档的分层骨架（coordinator / worker / gate / artifact 四层）、状态机 + 证据门禁 + 任务 DAG + 隔离上下文的整体范式站得住。Pro 方最硬的论点（保守并发、非目标边界、返工建模）无人实质反驳。问题在于几块承重墙是悬空的，而它们是**可修复的结构缺陷与未定义协议**，不是方向性错误。

---

## 最强辩护方观点（Pro）

| id | 观点 | 为何成立 |
| --- | --- | --- |
| P7 | §3 六条非目标是已落地的边界声明，每条对应一类失控源且有正文机制 | 文档中证据最硬、最少争议部分 |
| P5 | 保守并发（无依赖、无冲突、写范围可证明才并发，否则默认串行）是高风险闭环的正确默认值 | 方向无争议；Con 攻击的是实现缺口而非该默认值 |
| P8 | 返工建模为"动作 + 记录"而非一等持久 phase，避免状态笛卡尔积爆炸，`superseded_evidence` 可审计 | 设计取舍本身被各方接受 |
| P1 | 状态机 + gate + evidence 三件套权限分离（dispatch/submit/gate 正交），意在消除"自然语言声明完成" | 方向正确——**但信任强度依赖受信采集，见争议**；Pro 自己也在 open_question 中承认这一信任可能被高估 |

> 辩护方的诚实是本次审查的一个关键信号：Pro 在 `open_questions` 中**主动自承** 3 个边界——澄清循环可能不收敛、受信采集的信任强度可能被高估、epic 跨 run 能力可能被低估。这三点随后都被其他独立审查员以更强证据确认。

## 最强攻击方观点（Con / 维度）

| id | 观点 | 严重度 |
| --- | --- | --- |
| N1 / SR1 / FR2 | **反作弊地基"受信采集函数"全文仅 §12.6 一处提及，无实现、无调用方、无防篡改**。subagent 自跑 Bash 自报 exit_code，可跳过真实执行直接写 `exit_code:0` 指向伪造 `evidence_path`，gate 只校验字段存在、从不重放命令 | blocker |
| SR2 / AS3 | **gate 引擎由确定性代码还是 LLM coordinator 执行从未明确**（元前提）；且多个 gate 条件（"summary 短"、"测试空壳"、"能讲清"、"context_risk high"）实为语义判断，被伪装成布尔门禁 | blocker |
| N6 / CR1 / AR10 | 状态机存在死状态：`BLOCKED`/`FAILED` 无恢复出边，`VERIFIED` 失败无返回边，`REVIEWED→VERIFIED→COMPLETE` 为无 gate 守护的裸转移 | blocker |
| CR4 / N3 / N4 | `ready_frontier` 只查与 active 的冲突、**不校验同批候选间两两冲突** → 写范围重叠 task 会被同批并发派发；`conflicts()` 引用 schema 未定义的 `exclusive` 字段；`can_run_parallel` 定义了却无人读取 | blocker |
| AR1 / AR2 / AS1 | 五重 projection 双写无事务/原子写/崩溃恢复协议；`artifact-registry`、`navigation-map` 全文无 schema | blocker |

---

## 关键发现（按严重度）

| 严重度 | 置信 | 发现 | 证据 | 建议 |
| --- | --- | --- | --- | --- |
| blocker | high | 受信采集函数未定义——防伪地基悬空 | §12.6 条件8（全文唯一提及）、§14.2、§12.5 evidence 由 worker 产出 | 采集由 coordinator/独立 runner 执行，绝不由被审 worker 自身；gate 对关键命令独立重放或校验签名凭证 |
| blocker | high | gate 引擎执行体未定义（确定性代码 vs LLM） | §15.1 仅给函数签名、§3 目标10"不靠口头放行"、§4.1 Coordinator"gate 汇总" | 明确 gate 为确定性代码；语义判断项降级为"独立 reviewer 产 verdict，gate 只校验字段" |
| blocker | high | 状态机死状态与缺失返工边 | §5.2（BLOCKED 仅入边、FAILED 不出现、VERIFIED 无失败边、COMPLETE 前裸转移） | 补 BLOCKED/VERIFIED 恢复边、FAILED 进入条件、逐转移标注守护 gate |
| blocker | high | `ready_frontier` 不查候选间冲突 + 调度引用未定义字段 | §12.1 仅 `conflicts_with_active`、§12.3 用 `a.exclusive`、§11.2 `can_run_parallel` 不被读取 | frontier 选取时做候选两两冲突检测；定义/消费 `can_run_parallel`；补 `exclusive` 字段；定义 `path_globs_overlap` |
| blocker | high | 五重 projection 双写无事务、两个 projection 无 schema | §4 架构图、§6、§7、§8；`artifact-registry`/`navigation-map` 无 schema | 补两 schema；定义原子写 + 写序 + 崩溃恢复（events 重建 run-state）；裁定 SSOT vs evidence-first 权威 |
| blocker | high | 单轮 LLM 调用量级未量化、可能不可负担 | §13 verdict fan-out（reviewer×finding×rebutter3 ≈ 45）、§21 仅定性 | 给单轮典型/最坏调用量估算、per-run 预算与超限熔断 |
| high | high | 所有循环无强制迭代上限与用户硬停 | §10.4、§11.1、§5.1（均"直到…"措辞） | 每循环定义 max 迭代 + 超限降级路由 + 用户硬停入口（MVP 准入项） |
| high | high | worker 自写 evidence JSON 与非目标4冲突 | §12.4 `passing-tests.json` 是 worker 的 expected_output、非目标4 | 事实字段（exit_code）从 worker 可写 schema 剥离，改引用 collector 产出 |
| high | high | N=1 MVP 使二阶 verdict 失效但 gate 仍按多数票措辞 | §22 取 N=1、§13.2 `majority{count,of}`、§13.3 条款3 | 二选一：MVP 不主张对抗消除盲点，或明确 N=1 单票裁定规则并删多数票措辞 |
| high | high | §11.5-7 与 §11.4.5-4 对基础设施任务是否必须映射 AC 相反裁决 | §11.5 第7条 vs §11.4.5 第4条 | 统一规则，给基础设施任务显式标记字段 |
| high | high | SSOT 语义与 evidence-first 哲学冲突 | §5.3 第6条"优先信 run-state" vs §1"artifact=durable truth" | 裁定冲突场景权威，使两处文字自洽 |
| high | med | 并发部分失败无回滚/清理设计 | §14.1 `partial_delivery` 仅布尔、"rollback" 仅示例占位文本 | task 级原子提交边界（隔离工作区/分支）+ batch 失败回滚契约 |
| high | high | `coordinator-summary.md` 是主 agent 主要事实面但无一致性 gate | §9（读摘要）、§9.1（人工 prose）、§15.2（无 summary 校验） | summary 改为 run-state 确定性生成；state integrity gate 校验逐字一致 |
| high | high | plan hash 冻结无强制校验 | §11.6 仅存两字符串、§13.1 F-001 自暴露可在无 validated hash 下推进 | dispatch 前 gate 校验当前 plan hash==冻结值；写保护 `design.final.md` |
| high | high | forbidden_actions / recover 禁令仅 prompt 软约束 | §9.2、§18.3（散文声明，无运行时强制） | 落到运行时：run-state 字段写授权、recover 只读白名单、越权写拦截 |
| high | high | 多个关键术语未定义 | §12.6 受信采集、§12.3 exclusive 置位、§11.5 基础设施任务、§13.1 空壳测试、§4.1 Runtime adapter | 每术语补"定义 + 判定主体 + 输入/输出契约" |
| high | high | 同模型 reviewer 独立性名义化 | §13.1/§13.2 多 reviewer/rebutter、§1"isolated producers" | 异模型 / 强差异 persona / 引入确定性静态检查作独立第三方；显式承认相关性 |

> 完整 60+ 条 findings 见附录的 per-role 摘要。

---

## 维度审查（实际运行的 6 维度）

### correctness（正确性）
状态机多处缺陷（BLOCKED/FAILED 死状态、三循环无终止上限、REWORK 无计数）；调度伪代码 `ready_frontier`/`conflicts` 缺并发原子性、候选间冲突未检、被阻塞 task 可饿死、`path_globs_overlap` 未定义；`red test 确实先失败`无事后时序证据可被伪造；§11.5-7 与 §11.4.5-4 对基础设施任务给出相反裁决使 plan gate 逻辑上不可同时通过。**14 条 findings，含 2 blocker。**

### architecture（架构）
分层意图清晰但 Runtime adapter 层、调度层、两个核心 projection 只有名字没有 schema 或落地；SSOT 双写无事务与崩溃恢复；`§5.3 优先信 run-state` 与 `§1 artifact=durable truth` 自相矛盾；hash 冻结、跨阶段裸字符串外键、worker 约束均停留在声明性安全。**10 条，含 2 blocker。**

### control-plane-integrity（控制面完整性）
文档反复**声明**可信属性却几乎不**强制**它们：受信采集无机制、gate 执行体未定义、forbidden_actions 软约束、LLM 产出的 evidence 无自利/合谋/注入防护、recover 禁令无强制、hash 链延后期无防篡改基线。最根本缺口——worker（不可信生产者）与 gate（可信权威）之间的信任边界全靠约定而非进程/权限隔离。**9 条，含 2 blocker。**

### feasibility（可行性）
三处硬伤：单轮 Full pipeline 70–100+ 次 LLM 调用从未量化；受信采集在 subagent 模型下无独立实现；双 agent 循环无轮次上限依赖 LLM 自然收敛。另：无 worktree 时写隔离无法强制、~20+ schema 强依赖 LLM 稳定产出严格 JSON。**6 条，含 1 blocker。**

### risk（风险）
下行盲区集中在：并发部分失败无回滚（留半成品污染后续 frontier）、MVP 退化叠加出"不可检测且被误信"窗口、控制面自身摩擦致中小需求 ROI 负→团队整体弃用退回裸 agent 的**不可逆元风险**。多数缓解写了"做什么"，缺"失败时如何收场"。**8 条，多个 high，无 blocker。**

### assumption（假设）
"客观门禁"核心承诺建立在一组未验证脆弱假设上：多数 evidence 由 LLM 生成、多处 gate 实为语义判断、SSOT 崩溃一致性未定义、"可重放/可静态证明/受信采集"等关键术语缺操作定义、同底层模型使"对抗独立性"成为名义。**8 条，含 1 blocker。**

---

## 未解决的分歧（保留，不强求共识）

1. **三件套能否真正消除"自然语言声明完成"** —— P1（能，权限正交）vs N1/N2/SR1/FR2（不能，只是把声明从 NL 搬到 JSON 字段，且受信采集未定义）。**Pro 自承此信任可能被高估。** 这是全审查的总枢纽。
2. **run-state 作 SSOT、events 仅审计是否成立** —— P2（MVP 正确取舍）vs AS1/AR1/N7（崩溃/并发下无原子写、events 可能比 run-state 新，假设被否证）。争议核心：文档是否隐含了"单写者无崩溃"假设而未声明。
3. **SSOT 语义与 evidence-first 是否自洽** —— P1/P3 vs AR3（§5.3-6 与 §1 在冲突场景给相反权威）。
4. **双 agent 对抗是否有实质对抗价值** —— P4（critic/reviewer 有实质价值）vs AS8/N12/SR9/RR6（同模型共享盲点、N=1 使多数票失效）。
5. **epic 跨 run 能力是否被低估** —— Pro 自承 vs Con，双方实际收敛于"能力不足"，仅争严重度。

---

## 仲裁者推理

裁为 **revise** 的逻辑链：
- **置信 high 的依据**：9 条 blocker/high 来自 7 个互不可见的独立审查员 + 10 组收敛发现。独立隔离 subagent 收敛指向同一根因，按纪律应据此提升置信。
- **为何 revise 而非 block**：文档的四层骨架与整体范式站得住，Pro 最硬的 P5/P7/P8 无人实质反驳。问题不在方向错误，而在几块承重墙悬空——可修复的结构缺陷与未定义协议。
- **blocker 压过 approval**：头号议题（受信采集）与第二枢纽（gate 执行体）互相关联，都指向"谁来做不可被被审方操纵的判定"，共同构成必须在写代码前解决的**认识论地基**。其余 blocker（死状态、frontier 冲突、projection 事务、循环上限、调用量级、N=1 名实）是确定性工程缺陷，修复路径清晰、不改变方向。

> **Scribe 核验声明（对仲裁者输出的二次核验）**：仲裁者的 `arbiter_discovered_gaps` 中有两条引用了 `§12.7.5/§12.7.6`、`§16.3 的 MULTI_REQUEST_INTAKE / MERGE_QUEUE` 等内容。经回原文核验，**被审文档只有 25 节、§12 止于 §12.6、§16.3 的 dispatch 策略表并不包含这些状态**——这两条系仲裁者的幻觉引用，已从下方"仲裁者新发现"中剔除。保留的第 1 条（events.jsonl `actor` 字段无认证）在 §8.2 有真实依据，有效。对抗式审查的纪律同样适用于仲裁者本身：不盲信任何单一角色的输出。

---

## 必修项（进入实现前，按优先级）

1. **受信采集地基**（头号）：明确采集函数归属（coordinator/独立 runner，**绝不**由被审 worker 自身）、采集时机、`evidence_path` 写入权限；gate 侧对关键命令（red/green、verification）独立重放或校验签名凭证；若 subagent 运行时根本无法独立采集，必须**在文档中承认该限制**并把"防伪"降级为"结构完整性校验"，不得宣称消除自然语言声明。
2. **gate 引擎执行体**（元前提）：明确 gate 为确定性代码，其布尔结果对 LLM coordinator 不可篡改；凡需语义判断（空壳测试、summary 充分性、能否讲清）必须降级为"独立 reviewer 产结构化 verdict，gate 只校验字段"。
3. **状态机闭合**：补 BLOCKED→(各阶段) 恢复出边、VERIFIED 失败→IMPLEMENTING/PLANNING 返回边、FAILED 进入条件与终态语义；逐转移标注守护 gate。
4. **并发冲突闭合**：frontier 选取做候选两两冲突检测；定义并消费 `can_run_parallel`；为 task schema 补 `exclusive` 或删该分支；定义 `path_globs_overlap` 语义与并行 diff 合并/冲突检测机制。
5. **projection 一致性**：补 `artifact-registry`/`navigation-map` schema；定义 run-state 原子写 + 写序 + 崩溃恢复（events 重建 run-state）；裁定 SSOT 与 evidence-first 的最终权威并使两处文字自洽。
6. **循环终止**：每个循环（澄清/plan/adversarial/REWORK）定义最大迭代次数 + 超限降级路由 + 用户硬停入口（MVP 准入项）。
7. **调用量级预算**：补单轮典型/最坏调用量量化、per-run 预算与超限熔断，说明 N=1 降级如何把量级压到可承受。
8. **MVP N=1 名实**：二选一并改写 §13 条款——要么 MVP 不主张"对抗消除盲点"，要么明确 N=1 单票裁定规则并删除多数票措辞。

## 非阻断改进

- 统一各 verdict 字段枚举闭集（§10.3 / §10.6 / §13 三处取值域不交叉）。
- §11.5-7 与 §11.4.5-4 基础设施任务 AC 映射矛盾——统一为单一规则 + 显式 `infrastructure` 标记字段。
- plan hash 冻结增加强制校验点 + 写保护 `design.final.md`。
- task 饿死保护（老化/公平）与调度层运行期环检测。
- 复杂度阈值（AC>3、模块>2）补依据说明 + plan-reviewer 可下调复杂度的申诉路径。
- epic 跨 run：文档把 epic 归为"拆成多个 design/run"（§11.4.1）但未给拆分与子 run 间共享 acceptance contract 的机制；MVP 可明确**不支持** epic 并标注。
- `next_legal_action(s)` 单复数/结构统一（§15.1 数组 vs §18.2 对象）。

## 残余风险（即使修订后仍存在）

- **同模型 reviewer 独立性**：即便补齐 N≥3 + completeness critic，若所有 reviewer/rebutter 为同一底层模型，共享盲点与自利合谋无法被结构消除。需异模型或人工抽检缓解，文档应显式承认而非宣称已消除。
- **可重放假设**：对依赖网络/时间/随机/外部状态的命令（lockfile 解析、codegen、集成 smoke），即便补独立采集，"可重放"仍需环境锁定，否则只能降级为"可审计快照"。
- **控制面摩擦致 ROI 负**：70–100+ 次调用的重流程对一句话小需求仍可能 ROI 为负→团队绕过控制面。需"轻量路径先于重流程"作为持续设计约束。
- **静态 glob 证明 vs 运行时写入**：`allowed_write_paths` 为静态声明，无沙箱强制时事后 diff 校验 ≠ 运行时隔离，越界代码可能已污染工作树。

## 仲裁者新发现（审查员未提，经 scribe 核验保留）

- **events.jsonl 的 `actor` 字段无认证**（§8.2）：事件含 `actor`（如 `control-plane`）但无机制防止 worker 伪造 `actor:control-plane` 追加事件。worker 可写文件系统的前提下，审计 witness 自身的不可伪造性未建立——与受信采集同源，作用于审计层，应纳入防篡改设计。

> （仲裁者另提的两条新发现因引用了文档中不存在的章节/状态，已由 scribe 核验剔除，见上方核验声明。）

---

## 开放问题（需文档作者/领域负责人决断）

1. **总枢纽**：在 Claude Code subagent 执行模型下，命令证据能否独立于 worker 自报而可信？若不能，N1/SR1/FR2 成立，防伪承诺降级为"换载体"，是否动摇方案核心价值？
2. **元前提**：gate 引擎由确定性代码还是 LLM coordinator 执行？这决定 AS3/SR2/SR4 一整簇"客观 gate"攻击是否成立——需作者表态而非从文本推断。
3. run-state 的并发写者模型是什么？是否假设全程单进程主 agent 串行写入？并行 dispatch 后谁串行化对 `run-state.tasks` 的更新？
4. 跨阶段返工（review→PLANNING amendment）后，已冻结的 plan hash 如何与新 amendment 共存？冻结假设与 amendment 可变性是否矛盾？
5. 控制面摩擦的 ROI 元风险之外，是否需要一条"轻量降级路径必须先于重流程落地"作为准入约束？

---

## 附录：各角色原始输出摘要

> Full review 默认附原始输出。因 8 个 reviewer 合计 60+ 条 findings（远超 ~150 行），此处内联 per-role 摘要；完整结构化 YAML 保存在本次审查会话的各 subagent 输出中可回溯。

| 角色 | summary | findings 数 | 最高严重度 |
| --- | --- | --- | --- |
| Pro | 三件套权限分离扎实、artifact-first 务实、保守并发与 MVP 取舍清醒；自承 3 个边界 | P1–P8 | blocker（指出信任依赖，自承 open_question） |
| Con | 多处闭环可绕过：受信采集未定义、worker 自写 evidence、调度用未定义字段/忽略已定义字段、合并机制缺失、状态转移无守护 | N1–N14 | blocker（N1） |
| correctness | 状态机死状态/无终止上限/REWORK 无计数；调度无原子性/候选冲突未检/可饿死；gate 条件自相矛盾；red-test 无时序证据 | CR1–CR14 | blocker（CR1, CR4） |
| architecture | 五重 projection 双写无事务、两 projection 无 schema、SSOT 与 evidence-first 冲突、hash 冻结声明性安全、Runtime adapter 未落地 | AR1–AR10 | blocker（AR1, AR2） |
| control-plane-integrity | 反复声明可信属性却不强制；受信采集/gate 执行体/forbidden_actions/recover 禁令/hash 链空窗均无机制 | SR1–SR9 | blocker（SR1, SR2） |
| feasibility | 调用量级未量化（70–100+/轮）、受信采集无独立实现、双循环无上限、无 worktree 写隔离、schema 强依赖 LLM | FR1–FR6 | blocker（FR1） |
| risk | 并发部分失败无回滚、summary 无一致性 gate、不可检测窗口、控制面摩擦致弃用元风险 | RR1–RR8 | high |
| assumption | 客观门禁建立在脆弱假设上：语义判断伪装布尔、SSOT 崩溃一致性、可重放/静态证明/受信采集术语未定义、同模型独立性名义化 | AS1–AS8 | blocker（AS3） |

---

*本报告由 adversarial-agent-team 协议生成：8 个独立隔离审查员各自盲审 → 交叉质询锐化争议并回原文逐行核验 → 独立仲裁 → scribe 渲染并二次核验仲裁者输出。真实分歧已保留，未强求共识。*
