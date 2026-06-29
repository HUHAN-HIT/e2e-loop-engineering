# Worktree-Only 隔离设计 (路 B)

## 背景

Loop Engineering 的 4 个 Claude Code hook (`probe_and_gate` / `guard_paths` /
`post_task_collect` / `guard_anchors`) 都依赖一个共同的信任根:
`packages/shared/src/runs.ts` 的 `findActiveRun(cwd)` —— 扫 `<cwd>/runs/`
(或 `LOOP_RUNS_ROOT`)、按 run_id 字典序取**最新一个非终态** run、读不到就返回 `null`
→ 全部 gate 放行。

这个"扫磁盘猜活跃 run"的启发式很薄,派生出三类对用户真实可见的问题:

1. **hook 冲突 / worktree 隔离失效。** Claude Code 的 hook 在会话启动时按 **cwd**
   解析 `.claude/settings.json` 并合并所有匹配项 (PreToolUse 多 hook 是
   most-restrictive-wins)。若用户主工程已有与 e2e-loop 不兼容的 hook,而
   coordinator 会话又在主工程根启动,则两套 hook 同时生效、互相干扰。即便创建了
   worktree,现有 `syncProjectHookConfig`
   (`packages/ssot-ts/src/worktree/allocator.ts`) 还会把主工程 `.claude/`
   **整目录盲抄**进 worktree,把用户那套不兼容 hook 一起带过去,隔离根本没成立。

2. **无 run → fail-open (漏治理)。** 项目从没跑过 loop 时,gate 放行——这是期望行为,
   本身不是缺陷,但它说明"有没有 run"这件事被磁盘状态单方面决定。

3. **孤儿 run → fail-closed (误治理)。** 一个跑到一半被放弃的 run (phase 停在
   CREATED/CLARIFYING/PLANNING/IMPLEMENTING/WRAPPING_UP 等非终态) 会被
   `findActiveRun` **永久当成活跃**,持续用它**当时**的 phase + active task
   约束用户**现在**的日常开发:guard_paths 拦掉用户对源码的合法写入、guard_anchors
   拦掉用户结束回合;`probe_and_gate` 还会把这个孤儿 run 当成活跃 run 注入主 agent
   上下文,连协调器自己都被带偏。`run-state.json` schema
   (`packages/ssot-ts/src/schema/run_state.ts`) **没有任何会话绑定 / 心跳 /
   最后活动时间字段**,所以系统天然无法区分"此刻有活会话在驱动"与"上次崩在半路的尸体"。

三者同根。本 spec 不去给这个脆弱信任根打补丁 (那是"路 A":显式会话绑定 +
会话存活校验 + 三态路由,代价是 hook 判定逻辑复杂化 + 依赖宿主稳定 session_id),
而是用**物理隔离**把它绕到几乎用不到的角落。

## 当前事实 (代码接入点)

- `allocator.ts:syncProjectHookConfig(repoRoot, worktreePath)` 现在用
  `fs.cpSync` 把 `repoRoot/.claude` 与 `repoRoot/.opencode` **整目录盲抄**进 worktree。
  这是问题 1 的直接成因,也是本 spec 改动 ① 的落点。
- `packages/adapter-cc/src/install.ts` 已有完整的资产安装能力:`renderSettings(ctx)`
  生成只含 e2e-loop 4 hook 的 settings、`collectManifestEntries()` 枚举要落盘的
  skill/agent/hook 资产、`mergeHooks()` / `stripLoopEngineeringHooks()` 处理与既有
  settings 的合并/剥离。worktree 装 e2e-loop-only 资产应复用这套,不另写一份。
- `install.ts` 支持 `hookMode: local | cli | auto` (`--hook-mode`);worktree 内
  推荐 `cli` mode (见 `2026-06-28-cli-hook-entrypoint-design.md` 与
  worktree-allocator-design §"Hook 配置同步"),避免相对 `.mjs` 路径在 worktree 内失效。
- `packages/shared/src/hooks/probe_and_gate/logic.ts` 现在 SessionStart 只探测
  git/fs 能力 + 注入 active_run 提示,**不校验"当前是否在 loop worktree 内"**。
  这是改动 ② 的落点。其 fail-safe 是**退化放行** (不锁死会话),本 spec 必须守住这条。
- `allocator.ts` 已有 `allocateCreated` (always/auto 新建)、`assertWorktreeRootIgnored`
  (.gitignore 校验)、`cleanupManagedWorktree` (拒删 dirty/unmanaged)。
- `worktree-binding.json` (`packages/ssot-ts/src/worktree/binding.ts`) 写在
  **`runs/<run_id>/` 目录内** (非 worktree 根),字段含 owner=`loop-engineering`、
  mode、worktree_path、managed、status。
- CLI 已有 `init <req> --worktree-mode always`、`abort <run_id> --reason`,
  且 `--worktree-mode always` 时 runDir 落在 worktree 内、主工程根不留 `runs/`
  (`packages/cli/src/commands/dryrun.ts`)。

## 最终决策

采用 **Worktree-Only 隔离 (路 B)** 作为 Claude Code 宿主下使用 Loop Engineering
的**默认形态**:

> 每个 run 绑定一个**专属、一次性**的隔离 git worktree;coordinator 会话**只在该
> worktree 内**启动与运行;worktree 内的 `.claude/` **只含 e2e-loop 自己的资产**,
> 不携带用户主工程的任何 hook。

路 A (显式会话绑定) 降级为"未来若要支持**不用 worktree** 的场景再补"的可选项,
本期不做。

## 目标

1. coordinator 会话在 worktree 内运行时,只有 e2e-loop 的 4 个 hook 生效;用户主工程
   的不兼容 hook 不进入该会话的解析范围。
2. 用户回到主工程根做日常开发时,不被任何 loop 状态 (含孤儿 run) 拦截。
3. 在 SessionStart 显式识别"未在 loop worktree 内却加载了 e2e-loop skill"的情形并引导
   用户,而不是静默地让两套 hook 共存。
4. 保证"一个 worktree 一个 run、一次性、不复用"这条铁律可被机械校验,而非仅靠口头约定。
5. 守住协作范式红线与 `probe_and_gate` 的"不锁死会话"原则。

## 非目标

- 不实现路 A 的显式会话绑定 / 会话存活校验 / run-state 心跳字段。
- 不改 `findActiveRun` 的核心算法 (worktree-only 下它几乎不会误判,无需重写)。
- 不实现 task-level worktree (沿用 worktree-allocator 的 run-level 决策)。
- 不自动 merge worktree 分支回主分支、不自动解决 git 冲突 (沿用 allocator 非目标)。
- 不强制 OpenCode 宿主走 worktree-only (OC 经 plugin 生效,隔离模型不同,另议)。

## 核心改动 (三处)

### 改动 ① —— worktree 只装 e2e-loop-only 资产

把 `syncProjectHookConfig` 从"盲抄主工程 `.claude/`"改为"往 worktree 装一份干净的
e2e-loop-only `.claude/`":

- `settings.json`:用 adapter 的 `renderSettings()` **重新生成**只含 e2e-loop 4 hook
  的干净版,**不**抄主工程的 settings (那里混了用户 hook)。worktree 内默认 `cli`
  hook mode (与 cli-hook-entrypoint spec 配套,免相对 `.mjs` 路径失效)。
- skill/agent/hook 资产 (`skills/loop-engineering/`、`agents/<4>.md`、
  `hooks/loop_engineering/*.mjs`):从源装。
  - **源策略 (本期取选择性抄):** 从主工程**已装好的** `.claude/` 选择性复制 e2e-loop
    那几条路径。理由:路 B 的 bootstrap 前提就是"主工程已 `e2e-loop install`"(否则
    无法 `init`),复用那份资产最简单,且不踩 `install.ts` 在 npm 部署下的 `repoRoot()`
    源定位 TODO(P5)。
  - 备选 (P5 npm 后):直接调 adapter `install` 从包源装,届时 `repoRoot()` 重写后采用。
- `.opencode`:worktree-only 是 Claude Code 形态;OC 资产**不抄**(避免把 OC plugin
  误带入 CC worktree)。OC 的隔离另议。

### 改动 ② —— SessionStart enforcement (probe_and_gate)

`probe_and_gate` 在探测能力后,新增"当前是否在 loop worktree 内"的判定:

- **判据 (本期取 worktree 根 marker):** allocator 创建 worktree 时,在 **worktree 根**
  写一个轻量 marker (如 `.loop-engineering/worktree.json`,含 owner、run_id、created_at)。
  probe_and_gate 检测 cwd (或 cwd 向上若干级) 是否存在该 marker 且 owner=`loop-engineering`。
  - 不用"扫 runs/*/worktree-binding.json":binding 在 `runs/<id>/` 内、需解析、且要先定位
    runs;根 marker 判定快且不依赖 git。
  - 不用"git linked worktree + 分支前缀":分支可被改名,脆。
- **强度 (本期默认 warn,可配 deny):**
  - 检测到"已加载 e2e-loop skill 但 cwd 不是 loop worktree" → SessionStart 注入**醒目
    引导** (说明:不在隔离 worktree,e2e-loop hook 会与主工程 hook 共存可能冲突;给出
    bootstrap 命令)。**不 deny**,守住"不锁死会话"红线。
  - 通过配置项 (settings 或环境变量,如 `LOOP_REQUIRE_WORKTREE=1`) 可升级为 **deny**,
    供严格团队选择硬拒。
  - *待拍板:* "强制"二字与"不锁死会话"存在张力。本 spec 推荐"默认 warn + 可配 deny";
    若决策为"默认 deny",改本节默认值即可,其余设计不变。

### 改动 ③ —— "一个 worktree 一个 run" 铁律的机械校验

- allocator `always` 模式每次新建独立 worktree → 天然一对一。
- `init` / bootstrap 时:若 cwd 已是 loop worktree (根 marker 存在且已记 run_id) →
  **拒绝**在其中再 init 新 run (报错 + 提示"一个 worktree 只跑一个 run,请回主工程根
  bootstrap 新 run")。
- `adopt` 模式:若目标目录已绑定别的 run → 拒绝;worktree-only 下 adopt 不推荐 (复用易破
  一对一),文档标注。

## 工作流 (用户视角)

1. **bootstrap (纯 CLI,不开会话):** 用户在主工程根执行
   `e2e-loop init <requirement.md> --worktree-mode always` → 创建
   `.worktrees/<run_id>/`,在其中装 e2e-loop-only 资产 (改动 ①)、写根 marker (改动 ②)、
   初始化 run 目录。此步是普通 git/CLI 操作,不受任何 hook 影响。
2. **进 worktree 开会话:** `cd .worktrees/<run_id>/` 后启动 Claude 会话。主 agent 加载
   SKILL.md 成为 coordinator。该会话 hook 锚定 worktree → 只有 e2e-loop hook 生效。
3. **跑 run:** 正常推状态机 (PLANNING → IMPLEMENTING → ...),与现有流程一致。
4. **收尾:** run 跑完 → 合并分支回主线 / 或 `cleanupManagedWorktree` 清理 worktree。
5. **回日常:** 用户回主工程根开发 → 那里无 `runs/`、无 e2e-loop hook → 不被任何 loop
   状态干扰。

## 安全与失败策略

- **守红线:** `probe_and_gate` 异常仍**退化放行**;enforcement 默认 warn 不 deny。
- **孤儿降级为孤儿 worktree:** 废弃 run 连同其一次性 worktree 留在 `.worktrees/` 下,
  **不误伤任何人** (无人会进去日常开发),仅占磁盘。清理出口已有
  (`cleanupManagedWorktree` + 规划中的 `e2e-loop worktree cleanup`)。这是把"难缠的幽灵
  约束"换成"定期扫垃圾目录",是划算的交换。
- **非安全边界:** 本 spec 提升的是"误判面收敛 + 隔离",**不做密码学防伪** (SKILL §2)。
  诚实保证仍来自 post_task_collect 的独立重算与 coordinator 的客观自检。
- **Windows:** marker 写入复用 `directory.ts` 的 `atomicReplace` (杀软锁竞态重试)。

## 与现有设计的关系

- **worktree-allocator-design (2026-06-28):** 本 spec 是它的"使用形态收口"。allocator
  已提供 always/auto/adopt 与 binding;本 spec 把 always + "进 worktree 开会话"定为默认
  工作流,并收紧 `syncProjectHookConfig` 的资产策略。
- **cli-hook-entrypoint-design (2026-06-28):** 本 spec 依赖其 `cli` hook mode 作为
  worktree 内默认,免相对路径失效。
- **路 A (本 spec 的备选):** 显式会话绑定。本期不做,作为"未来支持非 worktree 场景"的
  可选演进保留。

## 测试覆盖

新增/调整测试建议:

1. `syncProjectHookConfig` 改造:主工程 `.claude/settings.json` 含用户自定义 hook →
   worktree 内 settings **只含 e2e-loop 4 hook**,不含用户 hook。
2. worktree 内 skill/agent/hook 资产齐全且可用 (cli hook mode 命令正确)。
3. `.opencode` 不被抄进 CC worktree。
4. allocator 创建 worktree 后,worktree 根存在 owner=loop-engineering 的 marker (含 run_id)。
5. `probe_and_gate`:cwd 在 loop worktree (有 marker) → 正常注入 active_run,不警告。
6. `probe_and_gate`:cwd 非 loop worktree 但加载了 skill → 注入醒目引导 (默认 warn,不 deny)。
7. `probe_and_gate`:`LOOP_REQUIRE_WORKTREE=1` 且非 worktree → deny (可配硬拒路径)。
8. `init`:cwd 已是 loop worktree (marker 已记 run_id) → 拒绝再 init,报错含"一个 worktree
   一个 run"。
9. 回归:用户主工程根无 `runs/` 时,4 个 hook 全放行 (孤儿 run 不再误伤已被物理隔离前提保证)。
10. `probe_and_gate` 内部异常 → 仍退化放行 (红线回归)。

验收命令:

```text
bun test tests-ts
npm run build
npx tsc --noEmit
```

聚焦测试 (最小实现):

```text
bun test tests-ts/install.test.ts
bun test tests-ts/ssot/worktree_allocator.test.ts
bun test tests-ts/probe_and_gate.test.ts
```

## 迁移策略

1. 改动 ① (worktree-only 资产) 与 ④ marker 先落地 (改 allocator + 复用 install 逻辑),
   不动 hook 判定。
2. 改动 ② (probe_and_gate warn 引导) 再落地,默认 warn,守红线。
3. 改动 ③ ("一 worktree 一 run" 校验) 跟进。
4. 文档:在 CLAUDE.md / README 写明"Claude Code 下默认在 worktree 内开发"的工作流与
   bootstrap 命令。
5. 旧用户 (在主工程根直接跑) 不被立即打断:默认 warn 仅引导,不强制;团队可按需开
   `LOOP_REQUIRE_WORKTREE`。

## 验收标准

- worktree 内 `.claude/settings.json` 只含 e2e-loop hook,无用户主工程 hook。
- coordinator 会话在 worktree 内运行时,用户主工程的不兼容 hook 不生效。
- 用户主工程根日常开发不被任何 loop 状态 (含孤儿 run) 拦截。
- SessionStart 能识别"非 worktree 内加载 skill"并给出引导 (默认 warn);可配 deny。
- "一个 worktree 一个 run" 可被 init 阶段机械拒绝违例。
- `probe_and_gate` 仍满足"异常退化放行、不锁死会话"。
- OpenCode 形态不受本 spec 影响。
