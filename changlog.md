# Changelog

本文件记录 Loop Engineering 工程的版本演进。版本号对齐 `core/manifest.json`。
每条修改登记在该版本下, 按"新增 / 修复 / 移除 / 文档"分类。

## 1.0.0 (2026-06-29)

首个正式发布到 npm registry 的版本 (5 包同发 `@e2e-loop/{shared,ssot,adapter-claude-code,adapter-opencode,cli}@1.0.0`)。

### 新增 — plan 拍板条件锚点化 (simple 免签) (2026-07-01)

把 `plan_signoff` 从"无条件必经人盯点"演进为**条件锚点**, 与 `wrap_up_signoff` 的条件收口锚点同构 ——
让 simple 且无风险的 run 不为一道形式化拍板停下等人, 同时对 medium/complex 及任何命中风险闸的 run 保留必经拍板。

- **免签判据**: run `complexity=simple` **且**未触发风险闸 (无 `risk: high` / `exclusive: true` task、无 service-contracts)
  **且**未强制 `require_plan_signoff` 时, `plan_check` 通过后**自动接受 (免签)** 进 IMPLEMENTING, 不设 `plan_signoff`
  人锚点。medium/complex 或命中任一风险闸的 run 仍必经计划拍板。
- **诚实记账 (绝不记为人工签署)**: 走免签路径的 run 在 `planning/plan-auto-accepted.json` 写下自动接受的审计标记
  (记录 complexity、免签判据), 明确区别于人工签署 —— 遵循"诚实高于合规外观"红线, 免签路径永不伪装成人签。
- **`RunConfig.require_plan_signoff` 开关**: schema 新增该字段 (默认 `false`); 置 `true` 可对任意 run **opt-out 回门禁**,
  强制走必经计划拍板 (用于对 simple run 也想人工把关的场景)。
- **CLI**: `e2e-loop init` 新增 `--require-plan-signoff` 标志, 把该开关写入 run-state.config。
- **文档**: `docs/loop-engineering-collaborative-design.md` (§1 / §7)、`docs/loop-engineering-master-prompt.md`、
  `docs/loop-engineering-prompts.md` 加 2026-07-01 方法论演进注, 把原"无条件计划拍板"表述限定为条件锚点。

### 修复 — actual_writes 误判 harness bootstrap 产物为 worker 越界 + install 落 .gitignore 托管块 (2026-07-01)

- **根因**: harness 在目标项目里落的 bootstrap 产物 (`.claude/` / `.opencode/` / `.loop-engineering/` /
  `.worktrees/` / `runs/` / `resume.cmd` / `resume.sh`) 会被 `git status --porcelain` 当 untracked 列出,
  进而被 `packages/shared/src/actual_writes.ts` 的 `tryGitDiff` 采集进 `actual_writes.paths`, 被
  `checkBoundary` 误判为 implementation-worker「越界写入源码」。
- **两处修法**:
  1. **治根 (shared)**: 新增 `packages/shared/src/harness_paths.ts`, 给出 canonical 产物路径集 +
     `isHarnessInternal(rel)` 判定 (反斜杠归一化 + 去尾斜杠, 处理 git porcelain 的 `.claude/` 尾斜杠形态);
     `computeActualWrites` 对三层 (git / fs / self_report) 返回的 paths 一律先经此过滤, 无论目标仓库
     gitignore 是否干净都不再误判。
  2. **保持目标仓库干净 (adapter-cc)**: `install` 在目标项目 `.gitignore` 写一个 `# >>> loop-engineering
     managed >>>` 托管块 ignore 掉这些产物 (`ensureHarnessGitignore`, 幂等); `uninstall` 对称清除该块
     (`removeHarnessGitignore`, 只删本工具托管块, 保留用户其它 ignore 条目)。install 落盘对称语义: 首装
     `.gitignore` 不存在 → 进 `writtenFiles`; 二次幂等装 → 进 `skippedFiles`。（adapter-oc 亦对称接入同一
     shared 能力, 双宿主一致——OC install/uninstall 复用 `ensureHarnessGitignore` / `removeHarnessGitignore`
     托管同一 `.gitignore` 块, 落盘/幂等/卸载语义与 CC 完全对齐。）
- **明确不动 `guard_paths` hook**: 它在 PreToolUse 拦主 agent 直接写源码是正确设计 (主 agent 只编排,
  不落具体实现代码), 本次只治理 actual_writes 采集侧的误判, 与 guard_paths 的写路径白名单正交。
- **传播**: 已装目标项目需 `e2e-loop install --host cc --project-dir <target> --force` 重装, 方在其
  `.gitignore` 落上托管块。

### 变更 — worktree bootstrap 支持 EnterWorktree 同会话续跑, 消除被迫重开 (2026-07-01)

问题: §0 规定主根会话 bootstrap 建 worktree 后停回合、让用户**重开**一个 worktree 会话续跑。逐层
挖到本质: 重开不是隔离的内在要求, 是 loop 把 hook 治理绑定到"会话启动 cwd"的选择(hook 每次执行按
`payload.cwd` 定位 run, run 在 `worktree/runs` 只有从 worktree 启动的会话 cwd 才对得上)。之前的
"自动重开"补救(弹终端 `resume` / headless)全撞环境壁垒: 无交互桌面(SESSIONNAME 空)+ agent 起的
子 claude 401 认证失败。

突破口(已实测两层验证): Claude Code 的 `EnterWorktree` 是"**同一会话内**建 worktree + 切 session
cwd", 不是重开。① cwd 探针证明 EnterWorktree 后 hook `payload.cwd` 跟随切到 worktree; ② 在装了
hook 的目标项目里, worktree 内建 run 后 Write `.claude/` 被 deny、Write 源码被 phase 门禁 deny
(reason 含 "phase=CREATED") —— 证明 `guard_paths` 在 worktree cwd 找到该 run 并按 phase 精准治理。
即"同会话切进 worktree, 治理跟上, 不重开、不损治理"。

- **coordinator §0 能力驱动分叉**(`core/coordinator.md`): 有 `EnterWorktree` 工具 → 调它切进
  worktree + `e2e-loop init --worktree-mode none`(run 落 `worktree/runs`)+ **本会话直接续跑到
  plan 签署, 零重开**; 无 `EnterWorktree`(OpenCode 等)→ 退回 `--worktree-mode auto` + `resume`/
  重开(现状)。遵循既有"有 AskUserQuestion 则弹框、无则文本"的能力降级范式, 不破坏双宿主一致。收口
  (COMPLETE)后 `ExitWorktree(action:"keep")` 保留分支供 commit/PR。
- **run_id 跨 worktree 防撞**(`dryrun.ts` `allWorktreeRunsRoots`): none 模式序号源纳入所有 git
  worktree 的 `runs/`(用 `git worktree list`), 避免各 EnterWorktree worktree 都从 `...-001` 撞号;
  非 git 降级为空、不回归。
- **`resume`/`runs` 降级为兜底而非主路径**: `resume`(上条新增的弹终端续跑)现仅作"无 EnterWorktree"
  降级路径的手动兜底; `runs` 并行总览仍用。连带提交 `resume` run 定位修复(`locateRunDir`: 从主根也
  能定位 worktree 模式 run)。
- **测试**: `worktree_prompt_contract` 加 EnterWorktree 分叉断言; `cli_worktree_seq` 测防撞序号源;
  `cli_resume` 定位回归。
- **传播**: 已装目标项目需 `e2e-loop install --host cc --project-dir <target> --force` 重装 SKILL.md。

### 新增 — worktree bootstrap 自动弹终端续跑 + e2e-loop runs 并行总览 (2026-07-01)

观察: 目标项目里 `e2e-loop init --worktree-mode auto` 建完隔离 worktree 后, 协调器按阶段 0 停回合,
让人**手动** `cd .worktrees/<run_id>` 再开新 Claude 会话续跑。根因: worktree 隔离要换 cwd + 换 `.claude`,
而 CC 治理 hook 在 SessionStart 冻结、会话内无法重载 —— 换会话是 agent 的能力盲区。但"换会话"是**能力性**
人工(该自动化掉), 与 `plan 签署` 这种**设计性**人锚点(SKILL §2 协作红线, 故意要人)不同, 不应让人在此被拦。

- **新增 `e2e-loop resume <run_id>`** (`packages/cli/src/commands/dryrun.ts` / `index.ts` / `help.ts`):
  读 run-state 拿 workdir, 按平台弹一个新终端在该 worktree 内起 `claude "/loop-engineering"` 会话续跑到
  plan 签署(win32 `start cmd /k`; darwin `osascript`; linux `x-terminal-emulator` best-effort)。纯函数
  `buildResumeSpawn(platform, workdir)` 便于单测, spawner 依赖注入(测试注入 fake, 不真弹窗); 无已知终端 /
  spawn 抛错 → 打印手动引导、退出 0(fail-safe 不锁死); none 模式 run(无 workdir)→ 提示就地续跑。
- **协调器 §0 handoff 改为自动续跑** (`core/coordinator.md` §5 阶段 0): bootstrap 后 coordinator 自动跑
  `e2e-loop resume <run_id>` 弹终端续跑再停回合, **人零操作**, 只在弹出窗口里等 plan 签署拍板; 保留 plan
  签署人锚点, 不碰协作红线, 不动 `worktreeGate`/`guard_paths`/`findActiveRun` 治理架构。
- **init 生成兜底脚本** (`runInit`): worktree 模式在 worktree 根写 `resume.cmd`/`resume.sh`(内容 cd + 起
  `claude "/loop-engineering"`), 自动弹窗失败时双击手动进入; 引导文案同步改为"coordinator 自动弹终端续跑"。
- **新增 `e2e-loop runs` 并行总览**: 扫主根 `runs/` + `.worktrees/*/runs/`, 表格列各 run 的 phase /
  human_pending / complexity / workdir(支持 `--json`), 并行开多 run 时一眼看全哪条支线停在 plan 签署。
- **测试**: `tests-ts/cli_resume.test.ts`(buildResumeSpawn 各平台 + none 模式 + spawn 降级 + 注入 spawner)、
  `tests-ts/cli_runs_overview.test.ts`(真 git 夹具, 主根 + worktree run 总览 / `--json` / 空), resume 脚本生成断言。
- **传播**: 已装目标项目需 `e2e-loop install --host cc --project-dir <target> --force` 重装 SKILL.md 方生效
  (源仓库 `core/coordinator.md` 是 SSOT)。

### 修复 — 目标项目阶段 0 CLI 定位修错配, 接线 doctor (2026-07-01)

观察到协调会话在**目标项目**(被 install 过资产、无 `packages/` 的普通仓库, 如 jeepay3)里跑阶段 0 时,
仍做一串无谓 shell 探测(`which e2e-loop` / `e2e-loop --version` / `e2e-loop --help | head` / `ls .claude/hooks`),
并据此**误判**"CLI 只暴露 install/uninstall"。经核对: 该目标项目的 SKILL.md **已是最新**(含 §3.5、行数与源
`core/coordinator.md` 一致), 全局 `e2e-loop@1.0.0` **功能完整**(`init`/`plan`/`run`/`dispatch`/`doctor` 全有)——
故此坑与 2026-06-30 那条的"旧快照未传播"**无关**, 是**提示词与目标项目形态错配**:

- 根因①: §3.5 原写"不确定就直接用项目内入口 `node packages/cli/dist/index.js`", 但目标项目**没有 `packages/`**,
  该逃生路径落空, 协调器被逼回退 `where`/`which` —— 恰是 §3.5 前半句禁止的动作(自相矛盾)。
- 根因②: 协调器用 `e2e-loop --version`(CLI 无此顶层标志 → 报"缺少子命令")+ `--help | head -N`(截断子命令列表)
  去探能力, 两个错误叠加 → 把功能完整的 CLI 误判成"只有 install/uninstall"。
- 根因③: `f6caf9d` 加了 `e2e-loop doctor` 却未在 `core/coordinator.md` 接线, 协调器不知该用它做机械 preflight。

修复(均在 `core/coordinator.md`):

- **§3.5 `e2e-loop` 定位改为分运行形态**: 目标项目里 `e2e-loop` 就是 install 写进 `settings.json` 的命令
  (默认全局 `e2e-loop`, 功能完整), 直接调用即可; 源码 checkout 里才用 `node packages/cli/dist/index.js`。
  显式禁止 `e2e-loop --version`(无此标志)与 `e2e-loop --help | head -N`(截断致误判)这两种探测手法,
  要看子命令就**完整**读 `--help` 或跑 `doctor`。
- **接线 doctor**: 两种形态都指向 `e2e-loop doctor`(源码 checkout 可 `--json` 一把梭校验入口/产物/文档);
  阶段 0 的"不要 shell 现探"清单补入 `e2e-loop --version`, 并回指 §3.5 的形态定位与 doctor。
- **doctor 目标项目适配未纳入本次**: 当前 `doctor` 的 `findRepoRoot` 面向源码 checkout(找 `core/manifest.json`
  + `packages/cli`), 在目标项目里会报多项 fail; 故本次措辞只在**源码 checkout**场景把 doctor 当一把梭,
  目标项目场景以 SessionStart 注入的 `active_run` + 直接调用全局 `e2e-loop` 为准(避免接线后在目标项目误导)。
- **传播**: 已装目标项目的 SKILL.md 需 `e2e-loop install --host cc --project-dir <target> --force` 重装方生效
  (源仓库 `core/coordinator.md` 是 SSOT)。

### 修复 — 协调器补 shell 纪律, 阶段 0 bootstrap 不再无谓 shell 探测 (2026-06-30)

观察到协调会话在 Windows 上做阶段 0 worktree bootstrap 时, 把 PowerShell 语法
(`if (Test-Path ...) {...} else {...}` / `Get-Content` / `$LASTEXITCODE`)塞进 Bash 工具,
触发 Git Bash 报 `syntax error near unexpected token '{'`。根因: `core/coordinator.md`
只描述了 worktree marker 与 `active_run` 信号, 但**未规定用什么工具探测**, 且全文**零 shell 纪律**,
导致 agent ① 无谓 shell 现探(`where` / `Test-Path` / `git worktree list`)② 混用 PowerShell/POSIX 语法。

- **新增 §3.5 工具与 shell 纪律**(`core/coordinator.md`):判会话状态/读产物优先用结构化工具
  (`active_run` 信号 + Read 工具), 不 shell 现探;必须执行命令时守"Bash 工具 != 系统原生 shell,
  一条命令只用一种语法、绝不混写"红线(Windows 上 Bash 工具=Git Bash POSIX, 系统原生=PowerShell;
  反斜杠/中文路径优先 PowerShell)。明确对 CC / OC 两宿主同等适用(OS 层差异, 与宿主无关)。
- **收紧阶段 0 bootstrap 措辞**(`core/coordinator.md` §5 阶段 0):判"在不在 worktree"优先看注入的
  `active_run`(权威信号), 需佐证再用 Read 工具读 marker, 显式禁止 `Test-Path`/`git worktree list`/
  `where e2e-loop` 现探, 指向 §3.5。
- **implementation-worker 同步补红线**(`core/subagents/implementation-worker.md` 第 3 步):worker
  是独立上下文、看不到协调器 §3.5, 而它"跑测试到绿"必然 shell 出去, 同样暴露此坑;在跑测试/git 处
  内联一条精简 shell 红线(同 §3.5 主旨)。
- **传播**:已装到目标项目的 `.claude/skills/loop-engineering/SKILL.md` 为旧快照, 需 `e2e-loop
  install --host cc --project-dir <target> --force` 重装方可生效(源仓库 `core/coordinator.md` 是 SSOT)。

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
