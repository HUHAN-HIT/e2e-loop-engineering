# Changelog

本文件记录 Loop Engineering 工程的版本演进。版本号对齐 `core/manifest.json`。
每条修改登记在该版本下, 按"新增 / 修复 / 移除 / 文档"分类。

## 1.0.0 (2026-06-29)

首个正式发布到 npm registry 的版本 (5 包同发 `@e2e-loop/{shared,ssot,adapter-claude-code,adapter-opencode,cli}@1.0.0`)。

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

### 修复 — worktree existing/adopt 分支补写根 marker (缺口 B, 2026-06-30)

`allocateRunWorktree` 此前只有 `created` 分支写 worktree 根 marker; `existing`(auto 命中已在
linked worktree)与 `adopted`(adopt)两条分支虽设了 `workdir`(令 run 进入 worktree 模式、激活
`worktreeGate`)却不写 marker, 导致 `worktreeGate` 因 `readWorktreeMarker(cwd)=null` 永久拒绝
该 run 的 dispatch/run。

- **统一经 `bindWorktreeMarker` 写 marker**(`packages/ssot-ts/src/worktree/allocator.ts`):新增
  helper, 写前核对既有 marker——若根已绑定属于本 owner 且 run_id 不同的 marker 则 throw 拒绝
  (机械兑现 spec 2026-06-29-worktree-only-isolation 改动③ 中 existing/adopt 分支缺失的"一个
  worktree 一个 run"防撞)。`created`/`existing`/`adopt` 三条分支统一调用本 helper。
- **测试**(`tests-ts/ssot/worktree_allocator.test.ts` 新增 3 例):adopt 写根 marker、auto-命中-
  linked-worktree 的 existing 分支写根 marker、目标根已绑别的 run 时拒绝。

### 文档 — coordinator 启动两会话边界 (缺口 A, 2026-06-30)

`core/coordinator.md` §阶段0 此前隐含"主工程根会话 init 后同会话继续推进", 但该会话 cwd 在主工程根:
后续 dispatch/run 被 worktreeGate 拒, 且其 loop hook 按非-worktree cwd 解析、worktree 隔离 hook 不生效。
据 spec 2026-06-29-worktree-only-isolation 的真实工作流, 改为明确"两会话边界":

- **`core/coordinator.md`:** §阶段0 worktree 段重写为"判断当前会话在不在 worktree"——不在(主工程根)则 init
  后只做 bootstrap 并交还人去 worktree 开新会话, 本会话不继续 PLANNING/dispatch/run; 已在 worktree 内
  则直接接续该 run、不再 init。"停回合的唯一依据"硬不变量增列 bootstrap 交还为合法停回合。
- **`docs/loop-engineering-master-prompt.md` / `docs/loop-engineering-prompts.md`:** §阶段0 / 启动步同步
  精简版两会话边界, 与 SKILL 一致(worktree_prompt_contract.test.ts 的三文档子串契约不破)。
- 纯文档改动, 无代码 / gate / allocator 变更。

### 修复 — 同步两条预存红测试 (2026-06-30)

全量套件里两条预先就红、与 worktree 改动无关的用例, 根因均为"产品有意变更后测试未同步", 非代码回归:

- **`tests-ts/publish_contract.test.ts`:** CLI 包已于 commit `9f1bd73` 有意改名 `@e2e-loop/cli` →
  `e2e-loop`(与 bin 名一致), 测试仍断言旧 scoped 名 → 更新断言为 `e2e-loop`。
- **`tests-ts/hook_binding_e2e.test.ts`:** "IMPLEMENTING 写 src/a.ts → allow" 用例 payload 无
  `agent_id`, writer-identity (B 案) 上线后被判主 agent → 主 agent 写源码正确 deny。IMPLEMENTING
  写源码的合法主体是 implementation-worker 子 agent, 故 payload 补 `agent_id`/`agent_type` 模拟子
  agent, 保留"in-scope 源码写入放行"的原意。
- 仅改测试, 无产品代码变更。

### 杂项 — 清理 CLI 改名后的残留引用 (2026-06-30)

commit `9f1bd73` 把 CLI 包改名 `@e2e-loop/cli` → `e2e-loop` 后, 两处功能性位置仍引用旧 scoped 名:

- **`tsconfig.json`:** path 别名键 `@e2e-loop/cli` → `e2e-loop`(无任何 import 使用, 纯一致性修正)。
- **`.changeset/{p1-cc-adapter,p2-oc-adapter,p5-m7-runtime-cli,p6-worktree-only-isolation}.md`:**
  front-matter 包名键 `@e2e-loop/cli` → `e2e-loop`, 避免未来 `changeset version` 因工作区无此包名而报错(正文叙述保留)。
- 历史记录(本 changelog 既往条目、`docs/` 设计与 spec 文档)按"准确反映当时状态"保留, 不做回溯改写。

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

### 新增 — Worktree-Only 隔离 (P6, 2026-06-29)

实施 spec `docs/superpowers/specs/2026-06-29-worktree-only-isolation-design.md` (路 B);
发布粒度见 `.changeset/p6-worktree-only-isolation.md`。Claude Code 宿主默认走"一 run 一专属
一次性 worktree"形态, 根治"主工程不兼容 hook 冲突"与"孤儿 run 误伤日常开发"。

- **改动① worktree 隔离 + 根 marker:** `syncProjectHookConfig` 不再盲抄主工程 `.claude/` ——
  worktree 内 `settings.json` 经 `keepOnlyLoopHooks` 过滤成只含 e2e-loop 4 hook (剥掉用户主工程
  hook, 隔离成立), 不抄 `.opencode`; allocator 在 worktree 根写 `.loop-engineering/worktree.json`
  marker。新增 `@e2e-loop/shared` 的 `worktree_marker.ts` (marker 读 helper `readWorktreeMarker`/
  `isInLoopWorktree` + loop hook 判据 + settings 过滤纯函数, **不反向依赖 ssot-ts**) 与
  `@e2e-loop/ssot` 的 `worktree/marker.ts` (marker 写, 走 `atomicReplace`)。
- **改动② enforcement 落 CLI 层:** 因 hook 要生效须先注册、主工程纯净则 `probe_and_gate` 不在场,
  引导/拦截改由 CLI 承担。`runInit` worktree 模式打印进 worktree 引导; `runDispatch`/`runRun` 加硬
  gate —— 仅对 worktree 模式 (`state.workdir` 非空) 的 run 生效, 要求 cwd 的 marker.run_id 匹配,
  否则退出码 2; none 模式一律放行 (零回归)。`probe_and_gate` 增 worktree 内一致性正向自检
  (cwd marker.run_id 与 active run 不一致则注入 `worktree_marker_warning`, 一致/无 marker 维持原
  行为, 异常仍退化放行守红线)。
- **改动③ 一 worktree 一 run:** `runInit` 在 `allocateRunWorktree` 前若检测到 cwd 已是 loop
  worktree (有 marker) 则拒绝再 init (退出码 2)。
- **测试:** 新增 `tests-ts/worktree_marker.test.ts` / `tests-ts/cli_worktree_gate.test.ts`,
  扩展 `tests-ts/probe_and_gate.test.ts` 与 `tests-ts/ssot/worktree_allocator.test.ts`;
  全量 bun **577 pass / 0 fail**, `tsc --noEmit` 0 error, none 模式集成测试
  (integration_dry_run / integration_dispatch_collect) 无回归。

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
