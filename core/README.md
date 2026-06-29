# Loop Engineering · Claude Code 三层工件

协作式 (非对抗) 多阶段开发 harness, 落地为 Claude Code 原生形态: **1 个 skill + 4 个子 agent + Python 算法参考库**.

## 三层结构

| 层 | 路径 | 职责 |
| --- | --- | --- |
| **skill (协调器提示词)** | `.claude/skills/loop-engineering/SKILL.md` | 主 agent 加载后即 coordinator, 推状态机、跑客观自检、计划必停人且收口异常/高风险才停人 |
| **craft 标准层** | `.claude/skills/loop-engineering/standards/*.md` | 各阶段"怎么做才算好"的判据/正反例/样例; 由 SKILL.md 与各子 agent 一行指针按需引用 |
| **subagents (4 个角色)** | `.claude/agents/*.md` | 由主 agent 通过 Task 工具按阶段分发, 隔离上下文产出 worker 产物 |
| **Python 算法 SSOT** | 已安装包中的 `loop_engineering/` | 协作式判断原语的可执行参考库 (路径相交 / checks 文法 / 保守扩围 / 契约 diff 等) |

## craft 标准层 (standards/)

`SKILL.md` + Python SSOT 规定了**状态机、产物 schema、客观门禁**(what + 红线); `standards/` 补上**"怎么做才算好"**(how-well) —— 这是信条 2「预防 > 检测」要求重投入、但此前未操作化的一层。

| 文件 | 关闭的缺口 |
| --- | --- |
| `glossary.md` | 客观可判定 / 阻塞性歧义 / 关键 diff / service 边界 / 任务粒度 的操作定义 + 反例 |
| `clarification-standard.md` | 该问/不该问、默认假设质量栏、问题上限 |
| `plan-standard.md` | AC 写法 + ID 规约、design.md 章节、拆分粒度判据、DAG 范式、task-plan 样例 |
| `test-design-standard.md` | AC→scenario→checks→代码 推导链、覆盖规则 (分档)、可机械判定断言反例 |
| `implementation-standard.md` | 测试写法约定、tests_green 操作定义、key-diffs "关键"判据、amend vs 硬做边界 |
| `review-standard.md` | 真 blocker vs 噪音、blocking_value 质量栏、severity 分级 |

**原则:** 每条规则带 `[S][M][C]` 复杂度档标记, simple 不套 complex (摩擦匹配复杂度); 标准是**指导 (Skill-first)**, 不是新增门禁或人盯点 —— 唯一门禁仍是 SKILL §6 的三组客观自检。standards 不重新引入任何对抗式/防伪机器。

## 子 agent 与阶段映射

| 子 agent | 阶段 | 何时分发 |
| --- | --- | --- |
| `clarification-finder` | CLARIFYING | 仅当存在阻塞性歧义 (多数 run 跳过) |
| `plan-agent` | PLANNING | 每个 run 一次, 产出全部计划契约 |
| `implementation-worker` | IMPLEMENTING | 每 task 一个, DAG ready frontier 渐进推进 |
| `red-team-reviewer` | 按需 | 人主动要求或某 task `risk: high` 在收口前 |

## §A 协调者不是子 agent

**重要:** 提示词集 (prompts.md) 的 §A "Coordinator" 章节**不**生成独立子 agent —— Claude Code 的**主 agent 本身就是协调器**. 主 agent 加载 `SKILL.md` 后, 由 SKILL.md 指导其推进状态机、调度子 agent、与人沟通. 把 §A 当成"另一个子 agent"是误读: 协调者是常驻主上下文, 持有 `run-state` 与各 artifact 的摘要/路径, 绝不自己写实现代码或读 worker 的长输出.

## 主 agent 协调流程概要

```
1. 接收需求 → 复杂度判定 (simple / medium / complex)
2. (按需) 分发 clarification-finder → questions.json, 默认可采纳则呈人
3. 分发 plan-agent → design.md / task-plan.yaml → 计划自检 → 呈人 plan_signoff
4. 按 DAG ready_frontier 分发 implementation-worker (并行/串行由冲突检测定)
   → 收回 test-results/summary/key-diffs → 任务自检 → 解锁下游
5. (按需) risk:high task 收口前分发 red-team-reviewer
6. 汇总 key-diffs → 收口自检；普通全绿自动 COMPLETE，失败/risk:high/exclusive 才设置 wrap_up_signoff
```

`plan_signoff` 是必经人锚点；`wrap_up_signoff` 是条件锚点，仅收口异常或高风险时让人停下确认。其余环节自动。

## Python 包何时被引用、何时不会被调用

- **会被引用 (作为 SSOT 脚注):** SKILL.md 和子 agent 提示词在需要描述某个判断原语时, 以脚注 `loop_engineering/<subpkg>/<file>.py:<function>` 形式标出参考实现. 主 agent 按描述执行, 不需要真的 import.
- **不会被运行时调用:** 主 agent 不会在 Claude Code 会话里执行 Python. `runtime/` / `dispatch/` / `cli.py` 仅用于本地 dry-run 与算法测试, Claude Code 入口不走它们.
- **可执行规范源:** 当提示词表述模糊时, 以 Python 包对应模块的实现与测试为唯一规范源.

## 测试入口

```powershell
loop-eng install-claude --project-dir <target-project> --force
.\.venv\Scripts\Activate.ps1   # 或 python -m venv .venv 后安装
pytest                          # 265+ 测试覆盖算法 SSOT
```

测试覆盖 `schema/` `state_machine/` `scheduling/` `checklists/` `amendment/` `multi_service/` `trust_mode/`; `runtime/` `dispatch/` `cli.py` 仅最小契约测试.
