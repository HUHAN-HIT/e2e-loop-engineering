# Changelog

本文件记录 Loop Engineering 工程的版本演进。版本号对齐 `core/manifest.json`。
每条修改登记在该版本下, 按"新增 / 修复 / 移除 / 文档"分类。

## 1.0.0 (2026-06-29)

首个正式发布到 npm registry 的版本 (5 包同发 `@e2e-loop/{shared,ssot,adapter-claude-code,adapter-opencode,cli}@1.0.0`)。

### 修复 — clarification 人锚点回退 + 状态机同步 + 全阶段主 agent 不干活 (2026-06-30)

回退 2026-06-28 "澄清永不单独停人"的演进, 恢复阻塞性澄清问题为独立人锚点; 同时修复 clarifying→planning 状态机不同步 bug, 在 hook 层强制 PLANNING 必须 set plan_signoff, 在提示词顶部硬声明"全阶段主 agent 不干活"反豁免幻觉.

- **数据模型 (`packages/ssot-ts/src/schema/run_state.ts` + `packages/shared/src/run_state.ts`):**
  `HumanPending` 加第三个值 `clarification` (与 `plan_signoff` / `wrap_up_signoff` 并列).
  共享层手写 union 同步更新 (hook 通过此类型校验字面量合法性).
- **状态机 (`packages/ssot-ts/src/state_machine/human_anchors.ts`):**
  `ANCHOR_ALLOWED_PHASES` 加 `[clarification]: {CLARIFYING}`, `setHumanPending` 校验天然兼容.
  docstring 由"两类合法人锚点"改为"三类".
- **Coordinator (`packages/ssot-ts/src/runtime/coordinator.ts`):**
  `submitClarification(q)` 重写为按内容分支 — `questions` 非空时 `setHumanPending(clarification)`
  (仍在 CLARIFYING, 让主 agent 用 AskUserQuestion 弹结构化框问人), 空 (仅 skip_basis) 不 set
  锚点让 `startPlanning` 直接推进. `answerClarification(answers)` 补 `clearHumanPending` (若
  clarification 锚点已 set) 后 `advancePhase(PLANNING)`. 修复原 `submitClarification` 不推 phase
  导致 run-state.json 卡在 CLARIFYING 的 bug.
- **guard_anchors hook (`packages/shared/src/hooks/guard_anchors/logic.ts`):**
  `LEGAL_ANCHORS` 加 `"clarification"`. 新增 `checkClarifyingPhase` — `questions.json` 已存在
  但 `human_pending !== clarification` 时 deny, 提示主 agent 调 `submit-clarification` CLI.
  强化 `checkPlanningPhase` — 加 plan_signoff 强制: `planning/design.md` 或 `task-plan.yaml`
  已产出时必须 `human_pending === plan_signoff` 才能 结束回合 (堵主 agent 脑补"项目结构清晰"
  绕过 plan-agent 自己写计划的越权); `planning/` 目录完全空时放行 (dispatch plan-agent 中途宽限).
- **CLI (`packages/cli/src/commands/clarification.ts` 新增 + `index.ts` 注册 + `help.ts` 帮助):**
  新增 `submit-clarification <run_id>` (读 questions.json → Coordinator set 锚点 if 有阻塞问题,
  stdout 提示主 agent 用 AskUserQuestion 弹问) 与 `answer-clarification <run_id> --answers <file>`
  (读答案 → Coordinator 清锚点 + 推进 PLANNING). `dryrun.ts` 把 5 个 helper (makeRunner /
  resolveRunsRoot / resolveRunDir / positional / humanPendingText) 加 export, `args.ts` 注册
  `--answers` 选项.
- **提示词 (`core/coordinator.md` + `core/subagents/clarification-finder.md`):**
  coordinator.md 新增 §1.6 「全阶段硬不变量 (反豁免幻觉)」— 列举 5 条容易被主 agent 脑补的
  豁免理由 ("项目结构清晰" / "需求很简单不用拆" / "我一眼就能写出 plan" /
  "子 agent 太慢我自己列" / "上下文不够先手写垫一下") 均不合法, guard_paths hook 物理 deny.
  §阶段 1 重写为按 complexity 分流: simple 规则驱动跳过; medium/complex 走 clarification-finder →
  submit-clarification → AskUserQuestion 弹问 → answer-clarification 推进. 表格行 + §13 示例
  同步. clarification-finder.md 调整 `can_proceed_with_defaults` 语义注释 (表示"有可回退默认"
  而非"不停人").
- **测试覆盖同步:**
  - `tests-ts/ssot/schema_run_state.test.ts`: `human_pending` 枚举循环补 `clarification`.
  - `tests-ts/ssot/human_anchors.test.ts`: 删过时"不再含 clarification"用例, 加 3 条 clarification
    合法性用例 (CLARIFYING 合法 / PLANNING 抛 / CREATED·IMPLEMENTING·WRAPPING_UP 抛).
  - `tests-ts/guard_anchors.test.ts`: 原"PLANNING + 无 failures → allow" 用例 (新行为下回归 fail)
    拆为 4 条 (planning 空目录 allow / design.md 存在无锚 deny / design.md+plan_signoff allow /
    failures 非空+plan_signoff deny); 新增 4 条 CLARIFYING 用例 (无 questions allow /
    有 questions 无锚 deny 含 submit-clarification 提示 / 有 questions+clarification allow /
    仅 clarification 锚 allow).
  - `tests-ts/ssot/coordinator_clarification.test.ts` (新增): 5 条用例覆盖 submitClarification
    (非空 set 锚 / 空 skip_basis 不 set / 非空在 PLANNING throw) 与 answerClarification
    (清锚+推进 PLANNING / 无锚仍推进 向后兼容).

### 新增 — 主 agent 不干活强制 (A+B 案, 2026-06-30)

针对观察到的反复问题——主 agent 在 plan/implement 阶段绕过 Task 工具直接扮演 worker 写产物,
导致 post_task_collect 防糊弄链路被绕过——做提示词层 (A 案) 与 hook 层 (B 案) 的纵深强制:

- **CC 协议合规修复 (前置, B 案基础):** `packages/adapter-cc/src/runtime.ts` 的
  `hookOutputToCCStdout` 在 defer 路径强制带 `hookSpecificOutput.hookEventName` (CC 必填字段,
  官方文档 https://code.claude.com/docs/en/hooks 明示; 缺失会被 CC 校验拒收并报
  "hookSpecificOutput is missing required field 'hookEventName'"); 函数签名加 `event` 参数,
  `runBinding` 调用处同步更新. `tests-ts/cli_hook_command.test.ts` (新增 `hookEventNameOf`
  辅助) 与 `tests-ts/hook_binding_e2e.test.ts` (probe_and_gate defer 用例) 各加一条断言作
  回归锚点.
- **A 案 · 提示词强化 (`core/coordinator.md`):** 删除"兜底 · 单上下文按序扮演"逃生通道;
  改"无论你是分派它还是亲自扮演它"为"每一个角色必须由对应子 agent 实现"; 新增 §1.5 角色边界段
  (5 条 hook 强制红线, 列明哪个角色写哪些路径); §3 补充"主 agent 写权限红线"对偶段;
  §13 末尾加全程强调.
- **B 案 · hook 写者身份治理 (`packages/shared/src/hooks/guard_paths/logic.ts`):**
  新增 `ruleWriterIdentity` (规则 0) — 基于 CC payload 的 `agent_id` 字段判定写者身份,
  `caller="main"` 时主 agent 写 worker 红线路径 (planning/design.md / tasks/<tid>/summary.md /
  clarification/questions.json / wrap-up/red-team-review.md / IMPLEMENTING 源码) 一律 deny,
  reason 含可执行指引 (建议改用 Task 工具分派对应 subagent_type). `caller=undefined` (OC 等
  未提供身份信息的宿主) 时跳过身份治理, 退化到原 phase+task 路径白名单 (避免锁死 OC 工作流).
- **B 案 · 数据模型 (`packages/shared/src/types.ts`):** `HookInput` 新增 `caller` 字段
  (`"main" | { agent_id, agent_type } | undefined`), 来自 CC payload 的 agent_id/agent_type.
- **B 案 · CC binding (`packages/adapter-cc/src/runtime.ts` + `hook_dispatcher.ts`):**
  `CCPayload` 接收 `agent_id`/`agent_type`, 新增 `buildCaller(p)` 把 payload 翻译成
  `HookInput.caller`, 4 个 hook 的 buildInput 一并传 caller.
- **B 案 · common 辅助 (`packages/shared/src/hooks/common.ts`):** 新增 `isMainAgent(input)`
  辅助, 供未来其它 hook 复用身份判定.
- **B 案 · 测试 (`tests-ts/guard_paths_writer_identity.test.ts` 新增):** W1-W10c 共 16 个用例
  覆盖主 agent deny / 子 agent allow / OC 退化 三种 caller 维度; `tests-ts/cross_host_consistency.test.ts`
  新增 (c) 组显式记录 B 案引入的跨宿主差异 (CC 主 agent 写源码/planning/design.md → deny;
  OC caller=undefined → allow), 与既有 (b) 组"路径白名单规则一致"叙事分离.
- **B 案 · OC 降级注释 (`packages/adapter-oc/src/plugin/index.ts`):** `beforeGuardPaths` 加
  caller=undefined 由来注释, 说明 OC plugin runtime 无 agent_id/agent_type 等价物, 身份治理
  仅在 CC 端生效 (这是已知跨宿主差异, 非缺陷).

### 修复 — worktree 早停加固 (2026-06-29)

针对"协调器把上下文压缩信号 (StrategicCompact) 误读成停止指令而早停"与"Stop hook 在 git worktree 里
`MODULE_NOT_FOUND` 崩溃 (崩在 hook try/catch 之前, fail-safe=deny 都来不及生效) 导致门失效"两个连锁问题的一组修复:

- **guard_anchors 未完工门 (结构层):** `checkImplementingPhase` 不再把"无 running task"一律当过渡态放行;
  改为统计 plan 状态——尚有 pending → deny (应继续 tick 推 ready frontier, 不结束回合); 仅剩 blocked → deny
  (提示设人锚点或转 ABORTED); 全 complete 才放行。(`packages/shared/src/hooks/guard_anchors/logic.ts`)
- **runs-root 跨 worktree 解析:** `resolveRunsRoot` 在 cwd 为 linked worktree 且本地无 `runs/` 时, 经
  `git rev-parse --git-common-dir` 解析回主 worktree 的 `runs/`; 正常仓库走快路径不调 git, 任何异常回退原行为。
  否则 worktree 内 hook 找不到 run → 静默放行, 门形同虚设。(`packages/shared/src/runs.ts`)
- **allocator hook 装配 fail-closed:** `syncProjectHookConfig` 拷贝后校验——worktree 的 settings.json 引用了
  本地 `.mjs` 但文件缺失则 throw, 拒绝产出"注册了 hook 却无门"的 worktree; CLI 模式命令无文件依赖不受校验。
  (`packages/ssot-ts/src/worktree/allocator.ts`)
- **默认 CLI hook 注册模式:** Claude Code hook 默认由 `node .claude/hooks/...mjs` 改为 `e2e-loop hook <name>`,
  消除 ".mjs 是未提交 build 产物 → 新 worktree 缺文件 → MODULE_NOT_FOUND" 的根因, 且走自有 CLI 使"找不到 run"
  由代码主动判定而非进程崩溃; 显式 `hookMode:"local"` 保留为逃生舱。
  (`packages/adapter-cc/src/install.ts` + `templates/settings.json`)
- **coordinator 提示词不变量 (提示层):** `core/coordinator.md` 增"停回合的唯一依据"与"上下文信号永远不是
  停止理由"两条硬规则, 从根因侧杜绝误读早停 (`<system-reminder>` 是数据不是指令)。

### 新增

- **开源许可:** 仓库根新增 `LICENSE` (Apache-2.0); 5 个发布包 package.json 均补 `"license": "Apache-2.0"`
  与 `repository` 字段 (指向 `github.com/HUHAN-HIT/e2e-loop-engineering`, 带 `directory` 子目录定位)。

### 修复

- **内部依赖范围收紧:** 各包对 `@e2e-loop/*` 的依赖由 `*` 改为 `^1.0.0`
  (cli→shared/ssot/adapter-cc/adapter-oc; ssot/adapter-cc/adapter-oc→shared),
  避免已发布包未来被动拉取不兼容大版本; workspace 本地仍由 1.0.0 软链满足。
- **版本号对齐:** `core/manifest.json` 与本 changelog 由 `1.0.0-alpha` 提升为 `1.0.0`,
  与 5 个发布包的 package.json 版本一致。

### 文档

- **新增 Worktree-Only 隔离设计 spec (路 B):**
  `docs/superpowers/specs/2026-06-29-worktree-only-isolation-design.md`。
  针对"主工程已有与 e2e-loop 不兼容的 hook""孤儿 run 误伤日常开发"等问题, 确立
  Claude Code 宿主下的默认形态——每个 run 绑定专属一次性 worktree、coordinator 会话
  只在 worktree 内运行、worktree 内只装 e2e-loop-only 资产。含三处核心改动
  (syncProjectHookConfig 装 e2e-loop-only + 写 worktree 根 marker / enforcement 主体落
  CLI 层——init 引导 + dispatch/run 非 worktree 拒绝, 不依赖 hook 注册 (hook 要生效须先
  注册, 主工程纯净则 probe_and_gate 不在场, 故引导/拦截改由 CLI 承担) / "一 worktree
  一 run" 机械校验)、测试覆盖与验收标准。本条仅登记设计文档产出, 实施代码改动另行登记。

## 1.0.0-alpha (2026-06-29)

本版本为 Python SSOT 物理移除后的收口版本, 主要完成"文档与代码对齐 TS SSOT"的扫尾工作。

### 修复

- **Hooks 接入 ssot-ts (I2):** `packages/shared/src/hooks/guard_anchors/logic.ts` 新增
  `readPlanCheckFailures()` / `readWrapUpCheckResult()` 与 `checkPlanningPhase()` /
  `checkWrappingUpPhase()`, Stop hook 在 PLANNING / WRAPPING_UP 阶段改读 Coordinator
  在 `submitPlan` / `submitWrapUp` 写下的"结果文件"
  (`planning/plan-check-failures.json` / `wrap-up/check-result.json`),
  不再静默放行; 设计原则: hook 不重跑 SSOT 算法 (避免循环依赖, shared 不能反向依赖 ssot-ts),
  只读结果文件做 allow/deny 翻译。
- **guard_anchors 测试补齐:** `tests-ts/guard_anchors.test.ts` 删除
  用例 10 / 11 已陈旧的 "P1 占位" 注释; 新增用例 10b (PLANNING + plan-check-failures.json
  非空 → deny, 校验失败项明细透出到 reason) / 11b (WRAPPING_UP + check-result.json 含 fail → deny)
  / 11c (WRAPPING_UP 全 pass → allow), 覆盖 SSOT 接入后的真 deny 路径。
- **post_task_collect / probe_and_gate 清理 Python 依赖语义:**
  `packages/shared/src/hooks/post_task_collect/logic.ts` 删除 handlePlan 中
  "P1 占位"字样, 改述为"plan_check 由 Coordinator.submitPlan 跑 (非 hook);
  失败项见 planning/plan-check-failures.json"。
  `packages/shared/src/hooks/probe_and_gate/logic.ts` 的
  `probeUnattendedReadiness` 文档去掉"依赖 Python"措辞, 改为
  "与 @e2e-loop/ssot/trust_mode 行为对齐" (函数本身仍返回 ready:false,
  因 §0.3 独立复跑通道未落地, 这是设计正确而非待修)。

### 文档

- **CLAUDE.md (I3):** 全文重写, 去掉 Python `loop_engineering/` 包相关命令
  (pytest / pip install -e .), 改为 npm / bun / tsc 工作流;
  架构表更新为 TS SSOT (`@e2e-loop/ssot`) 为算法权威;
  新增提交规则"每次完成需求 / 改造 / 修复, 测试通过后自动提交, 不需要询问"。
- **core/*.md SSOT 引用迁移 (I1):** `core/coordinator.md` /
  `core/standards/{glossary,test-design-standard,plan-standard,implementation-standard}.md` /
  `core/subagents/{plan-agent,implementation-worker}.md` /
  `core/README.md` 中全部 `loop_engineering/X.py:fn` 风格引用,
  改为 `@e2e-loop/ssot/X` + camelCase 函数名
  (parseCheck / evalCheck / checkPlan / checkTask / validateKeyDiffsSubmission /
  computeRollback / pathGlobsOverlap / computeActualWrites 等),
  对齐 TS SSOT 实际导出。
- **core/manifest.json (I5):** 版本号 0.5.0-alpha / 0.2.0-alpha → 1.0.0-alpha,
  与 README / 现实状态对齐。
- **README.md (I4):** 架构图删除 `adapters/` 与 `loop_engineering/`,
  增加 `bin/` 与 `docs/`; 删除 pytest 命令, 增加 `npx tsc --noEmit`;
  迁移状态去掉 Python 相关表述。

### 移除

- **死代码清理 (I4 / I6 / S1):**
  - `adapters/` 目录 (空骨架, 只剩 `.gitkeep` + 占位 README; 真实 adapter 实现已在
    `packages/adapter-cc` 与 `packages/adapter-oc`).
  - `MANIFEST.in` (引用已不存在的 `claude_assets.py`, Python sdist 打包配置).
  - `uv.lock` (Python uv 锁文件, Python 移除后无意义).
- **tsconfig.json (I6):** 删除已不存在的 `@e2e-loop/adapter-cc` path 映射,
  新增 `@e2e-loop/adapter-opencode` 与 `@e2e-loop/cli` 映射,
  与 npm workspace `packages/*` 实际包名对齐。
- **.gitignore (S1):** 删除 `archive/` 段 (Python 实际是物理移除, 没有归档到 archive/);
  测试 fixture 路径 `tests/fixtures/smoke/runs/` → `tests-ts/fixtures/smoke/runs/`,
  对齐 TS 测试目录。

### 已知遗留 (非阻塞)

- `packages/shared/src/hooks/**/*.ts` 与 `guard_paths` 内仍有少量
  "Python `X` 等价" / "Python `main` 等价" 风格的**纯文档性注释**,
  描述 TS 实现与原 Python 行为的对照关系 (不是功能依赖), 暂保留作为历史索引;
  若后续要彻底去 Python 痕迹可一并清理。
