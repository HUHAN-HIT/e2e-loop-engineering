# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目本质 (必读)

Loop Engineering 是一个**协作式 (非对抗) 多阶段开发 harness**。它落地为 Claude Code / OpenCode 双宿主原生形态, 由**三层工件 + 算法 SSOT**组成:

| 层 | 路径 | 角色 |
| --- | --- | --- |
| **skill (协调器提示词)** | `core/coordinator.md` (install 时落 `.claude/skills/loop-engineering/SKILL.md`) | 主 agent 加载后即 coordinator, 推状态机、跑客观自检 |
| **craft 标准层** | `core/standards/*.md` | 各阶段"怎么做才算好"的判据/正反例 (按需引用, 不是新门禁) |
| **subagents (4 个角色)** | `core/subagents/*.md` (install 时落 `.claude/agents/`) | clarification-finder / plan-agent / implementation-worker / red-team-reviewer |
| **TS 算法 SSOT** | `packages/ssot-ts/` (`@e2e-loop/ssot`) | 协作式判断原语的可执行实现 (zod schema + 纯函数) |

**关键边界:** TS SSOT **不是** Claude Code 实际运行的协调器入口。Claude Code 的主 agent 即协调器, 由 SKILL.md 指导; 子 agent 由 `.claude/agents/*.md` 定义; 主 agent 通过 Task 工具分发 worker。SSOT 仅在提示词需要描述某个判断原语 (路径相交、checks 文法、保守扩围、契约 diff 等) 时作为**可执行规范源**被引用 (脚注形式指向 `@e2e-loop/ssot/<subpkg>`), **不在会话中被 import 调用**。`runtime/` `dispatch/` CLI 子命令仅用于本地 dry-run 与算法测试。

**历史:** 原 Python `loop_engineering/` 包已于 2026-06-28 (用户决策) 物理移除, TS SSOT (`packages/ssot-ts`, zod 版) 是唯一在库权威。

## 常用命令

```powershell
# === npm / TS 工具链 (P1-P5 已落地, 唯一工具链) ===
npm install            # workspace 安装 (zod / js-yaml / 串包)
npm run build          # 构建 adapter-cc hooks(.mjs) + adapter-oc plugin(.js) + cli bundle
npx tsc --noEmit       # 类型检查 (无独立 lint)
npx bun test tests-ts/ # TS 等价/集成/跨宿主一致性测试 (设计 D-4 用 Bun; 本机经 npx bun@1.3.14)

# 落资产到目标项目 (cc=Claude Code, oc=OpenCode, both=双装)
node packages/cli/dist/index.mjs install   --host <cc|oc|both> --project-dir <target> [--force]
node packages/cli/dist/index.mjs uninstall --host <cc|oc|both> --project-dir <target>
node packages/cli/dist/index.mjs list      --project-dir <target>

# 算法 dry-run (本地骨架验证, worker 用 echo 占位; TS runtime)
node packages/cli/dist/index.mjs init <req.md>
node packages/cli/dist/index.mjs plan <run_id> --design <file> --task-plan <file>
node packages/cli/dist/index.mjs signoff-plan <run_id>
node packages/cli/dist/index.mjs run <run_id>
node packages/cli/dist/index.mjs status <run_id>

# 真实 run 分发 (主 agent 当 coordinator, 配合 Task 工具派 implementation-worker)
node packages/cli/dist/index.mjs dispatch <run_id>
node packages/cli/dist/index.mjs collect-outcome <run_id> --task <id>
```

无独立 lint/format 命令。TS 侧用 `tsc --noEmit` 把关。

## 架构 (跨多文件才能拼出的全景)

### 状态机 (唯一推进依据)

```
CREATED → CLARIFYING(可跳过) → PLANNING → IMPLEMENTING → WRAPPING_UP → COMPLETE
任意 phase → ABORTED (必须给 reason)
```

合法迁移矩阵见 `packages/ssot-ts/src/state_machine/transitions.ts` (`canTransition` / `LEGAL_TRANSITIONS`)。task 级四态 `pending/running/blocked/complete` 由 scheduling 维护, 不在 state_machine。**人盯锚点**: `plan_signoff` 为必经计划拍板; `wrap_up_signoff` 仅在收口自检失败、risk:high 或 exclusive task 时设置; 详见 `state_machine/human_anchors.ts`。

### 单 tick 顺序 (严格固定, design §3.7)

`packages/ssot-ts/src/runtime/tick.ts` 的 `tick` 是纯函数, 按以下顺序执行:
1. **ABORTED 短路** (优先级最高)
2. 收回已交回的 worker outcomes (跑 `collectOutcome` + 任务自检)
3. **watchdogTick** (检测超时, recycle / mark_blocked)
4. **readyFrontier** 选 ready task → 立即翻 running → 派发 packet
5. 透传 human_pending 状态 (tick 自身不设 anchor, 那是 coordinator 的 `submit_*` 方法的事)

`Coordinator` (`packages/ssot-ts/src/runtime/coordinator.ts`) 是 `run-state.json` 与 `planning/task-plan.yaml` 的**单写者**; 持有 state + plan + 跨进程恢复读回的 plan (CLI 每个子命令重建 Coordinator, 必须从 yaml 恢复 plan, 否则后续命令断链)。

### 算法 SSOT 子包 (按职责分类)

- `schema/` — zod 数据模型 (RunState / TaskPlan / Artifacts / Clarification / ServiceContracts)
- `state_machine/` — phase 迁移合法性、人锚点阶段矩阵
- `scheduling/` — `path_overlap.ts` (写路径是否冲突), `ready_frontier.ts` (DAG 就绪前沿), `watchdog.ts` (超时回收), `capabilities.ts` (宿主能力探测); actual_writes 复用自 `@e2e-loop/shared`
- `checklists/` — `checks_eval.ts` (checks 文法 `<lhs> <op> <rhs>` 手写递归下降解析), `key_diffs_gate.ts` (risk:high task 的 key-diffs 硬 gate), `plan_check.ts` / `task_check.ts` / `wrap_up_check.ts` (三组客观自检)
- `amendment/` — `ac_index.ts` (AC↔task 反查索引), `rollback.ts` (保守扩围: 改契约时回滚触及 AC 的相关 task)
- `multi_service/` — `contracts_diff.ts`, `propagation.ts` (契约变更传播隐式依赖), `service_map.ts` (service → 物理仓库映射)
- `trust_mode/` — `gate.ts` (collaborative ↔ unattended 切换门; 切 unattended 前必须 probe 独立复跑通道)
- `runtime/` — `coordinator.ts` / `tick.ts` / `directory.ts` / `navigation_map.ts` / `yaml_io.ts`
- `dispatch/` — `packet.ts` / `worker_runner.ts` / `collect.ts`
- `worktree/` — `allocator.ts` / `binding.ts` (隔离 git worktree 分配)

### 共享层 (`packages/shared`)

4 个 hook 的宿主无关 logic (`packages/shared/src/hooks/<name>/logic.ts`) + 公共底座 (`common.ts`) + `path_match.ts` + `actual_writes.ts`。同一份 logic 被 CC binding (`packages/adapter-cc`) 与 OC binding (`packages/adapter-oc`) 复用, 保证两宿主决策一致。

### Claude Code Hooks (4 个, 由 settings.json 注册)

实现于 `packages/adapter-cc/src/hooks/`, `e2e-loop install --host cc` 时编译为 `.mjs` 落到目标项目的 `.claude/hooks/loop_engineering/`:
- `probe_and_gate` — **SessionStart**: 探测 git/fs 能力, unattended 档的就绪校验 (异常时**退化放行**, 不锁死会话)
- `guard_paths` — **PreToolUse Write|Edit**: 路径白名单 (按 phase + active task 判定可写范围; `.claude/**` 与 `loop_engineering/**` 永远 deny)
- `post_task_collect` — **PostToolUse Task**: 防糊弄——独立重算 actual_writes 覆盖 worker 自报告, 校验必需 artifact 落盘
- `guard_anchors` — **Stop**: 校验当前 phase 的自检通过才允许结束回合 (合法人锚点放行)

`packages/shared/src/hooks/common.ts` 是 4 个 hook 的公共底座 (stdin JSON 解析、run 目录定位、状态读写)。

### 产物布局 (design §6)

```
runs/<run_id>/        # run_id 格式 YYYYMMDD-NNN
  run-state.json      # 单写者: Coordinator
  input/requirement.md
  clarification/questions.json
  planning/{design.md, task-plan.yaml, [service-contracts.yaml], plan-check-failures.json}
  tasks/<id>/{test-results.yaml, summary.md, key-diffs.yaml, logs/}
  wrap-up/{check-result.json, key-diffs.md, [integration-results.json]}
```

## 重要约定 (坑点)

- **`.claude/` 不存在于本实现仓库** —— 这是**故意的**。所有 Claude 资产 (skill/agents/hooks/settings) 都打包在 `packages/adapter-cc/` 与 `core/` 内, 通过 `e2e-loop install --host cc --project-dir <target>` 同步到**目标项目**的 `.claude/`。`packages/adapter-cc/src/install.ts` 是这条边的唯一同步器, **永远不从实现仓库的 `.claude` 读**。
- **checks 文法白名单** (design §3.1): 每条只允许 `<lhs> <op> <rhs>`, op ∈ `{==,!=,in,not in,<,<=,>,>=}`, rhs 为字面量。不允许函数、嵌套、自然语言——否则该用例退回重写。形式定义见 `packages/ssot-ts/src/checklists/checks_eval.ts` (`parseCheck` / `evalCheck`)。
- **case 输出 schema 严格固定** 为 `{id, passed: bool, failure_reason: str}`——worker 自创字段会被判该 check 失败 + 告警。
- **`actual_writes` 三层采集**: git diff (authoritative) > fs snapshot (authoritative) > worker 自报告 (软约束)。越界检测两层: 不在 `allowed_write_paths` 内、或已被更早 task 写过。实现于 `packages/shared/src/actual_writes.ts` (`computeActualWrites` / `checkBoundary`)。
- **Windows 文件锁**: `packages/ssot-ts/src/runtime/directory.ts` 的原子替换对 `os.replace` 重试 5 次 (退避 25ms) 处理杀软扫描竞态——改写持久化时保持此模式。
- **复杂度档 `[S][M][C]`**: `core/standards/` 中每条规则带档位标记; simple 不套 complex 标准 (摩擦匹配复杂度)。改 craft 标准时遵守此约定。
- **协作范式红线** (SKILL §2): 不做密码学防伪、不做时序快照、不让两个角色互相否决。"诚实高于合规外观"——谎报是本范式唯一致命失败。
- **代码注释统一用中文**, 与现有 SSOT 风格一致。

## 规范源文档 (出入门径)

`docs/` 下保存了完整方法论与多轮评审记录, 改算法/状态机/schema 时回查:
- `docs/loop-engineering-collaborative-design.md` — **规范源** (design 节号在代码 docstring 中到处引用, 如 "design §3.7")
- `docs/loop-engineering-cross-host-design.md` — 跨宿主适配 (CC + OC) 的设计源与路线图
- `docs/loop-engineering-master-prompt.md` — 自包含、模型无关的协调器系统提示
- `docs/loop-engineering-prompts.md` — 4 个子 agent 提示词集合
- `docs/superpowers/specs/` — 增量设计规格 (worktree allocator / cli hook entrypoint / cross-stack test policy)
- `docs/archive/reviews/` — 多轮对抗/协作评审记录归档 (历史参考, 不再是规范源)

`tests-ts/fixtures/smoke/` 是端到端冒烟样例 (1-task simple run), 可用作 CLI 流程的具体例子。

## 提交规则
每次完成一次需求，或者改造，或者修复问题，完成代码开发之后，确认所有测试都通过，无问题之后，请自动提交，不需要询问

## 开发规范

- 主agent负责任务编排，不负责具体任务执行。具体任务执行交由subagent
- 每次修改都需要在changlog.md文件上对应的版本下增加修改的内容

