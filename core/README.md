# Loop Engineering · 三层工件 (宿主无关 SSOT)

协作式 (非对抗) 多阶段开发 harness, 落地为 Claude Code + OpenCode 双宿主原生形态: **1 个 skill + 4 个子 agent + TS 算法 SSOT**.

> 本目录是宿主无关的"源" (`coordinator.md` / `subagents/` / `standards/` / `manifest.json`), 由 `packages/adapter-cc` 与 `packages/adapter-oc` 在 `e2e-loop install` 时渲染并落到目标项目的 `.claude/` 与 `.opencode/`.

## 三层结构

| 层 | 源 (本仓库) | 落到目标项目 | 职责 |
| --- | --- | --- | --- |
| **skill (协调器提示词)** | `core/coordinator.md` | `.claude/skills/loop-engineering/SKILL.md` | 主 agent 加载后即 coordinator, 推状态机、跑客观自检、计划必停人且收口异常/高风险才停人 |
| **craft 标准层** | `core/standards/*.md` | `.claude/skills/loop-engineering/standards/*.md` | 各阶段"怎么做才算好"的判据/正反例/样例; 由 SKILL.md 与各子 agent 一行指针按需引用 |
| **subagents (4 个角色)** | `core/subagents/*.md` | `.claude/agents/*.md` | 由主 agent 通过 Task 工具按阶段分发, 隔离上下文产出 worker 产物 |
| **TS 算法 SSOT** | `packages/ssot-ts/` (`@e2e-loop/ssot`) | 不落地 (仅在仓库内供 hook/CLI 调用) | 协作式判断原语的可执行实现 (路径相交 / checks 文法 / 保守扩围 / 契约 diff 等) |

## craft 标准层 (standards/)

`SKILL.md` + TS SSOT 规定了**状态机、产物 schema、客观门禁**(what + 红线); `standards/` 补上**"怎么做才算好"**(how-well) —— 这是信条 2「预防 > 检测」要求重投入、但此前未操作化的一层.

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

## SSOT 何时被引用、何时不会被调用

- **会被引用 (作为 SSOT 脚注):** `coordinator.md` 和子 agent 提示词在需要描述某个判断原语时, 以脚注 `@e2e-loop/ssot/<subpkg>` (TS) 形式标出参考实现. 主 agent 按描述执行, 不需要真的 import.
- **不会被运行时调用:** 主 agent 不会在 Claude Code 会话里直接 import SSOT. SSOT 在仓库内被 hooks (经 `@e2e-loop/shared`) 与 CLI (`packages/cli`) 调用; 目标项目通过 install 落盘的 `.mjs` 已 bundle 进相关逻辑.
- **可执行规范源:** 当提示词表述模糊时, 以 `packages/ssot-ts/` 对应模块的实现与测试为唯一规范源.

## 测试入口

```bash
npm install                      # workspace 安装
npm run build                    # 构建 adapter-cc/adapter-oc/cli 产物
npx bun test tests-ts/           # 全套 TS 测试 (等价 + 集成 + 跨宿主一致性)
npx tsc --noEmit                 # 类型检查
```

测试覆盖 `schema/` `state_machine/` `scheduling/` `checklists/` `amendment/` `multi_service/` `trust_mode/` `runtime/` `dispatch/` `worktree/`; 等价测试在 `tests-ts/ssot/`, 集成与跨宿主一致性在 `tests-ts/` 根。
