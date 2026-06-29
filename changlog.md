# Changelog

本文件记录 Loop Engineering 工程的版本演进。版本号对齐 `core/manifest.json`。
每条修改登记在该版本下, 按"新增 / 修复 / 移除 / 文档"分类。

## 1.0.0 (2026-06-29)

首个正式发布到 npm registry 的版本 (5 包同发 `@e2e-loop/{shared,ssot,adapter-claude-code,adapter-opencode,cli}@1.0.0`)。

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
