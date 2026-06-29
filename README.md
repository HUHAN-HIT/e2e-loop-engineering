# Loop Engineering

协作式 (非对抗) 多阶段开发 harness, 落地为 **Claude Code + OpenCode 双宿主**原生形态: 一份宿主无关核心 (提示词 + 算法 SSOT), 两份宿主适配 (Claude Code hooks / OpenCode plugin), 推同一套状态机驱动的协作流程 (澄清 → 计划 → 实现 → 收口), 并由"路径白名单 / 防糊弄 / 人盯锚点"三道护栏守护。

规范源: [`docs/loop-engineering-cross-host-design.md`](docs/loop-engineering-cross-host-design.md) (跨宿主适配) 与 [`docs/loop-engineering-collaborative-design.md`](docs/loop-engineering-collaborative-design.md) (算法/状态机/schema)。

---

## 安装 (npm-first)

本仓库是 npm workspace monorepo。从源码安装:

```bash
npm install        # 安装 workspace 依赖
npm run build      # 构建 adapter-cc hooks (.mjs) + adapter-oc plugin (.js) + CLI bundle
```

用 CLI 把资产落到目标项目 (`<cc|oc|both>`: cc = Claude Code, oc = OpenCode, both = 双装):

```bash
node packages/cli/dist/index.mjs install --host cc   --project-dir <path>   # 仅 Claude Code
node packages/cli/dist/index.mjs install --host oc   --project-dir <path>   # 仅 OpenCode
node packages/cli/dist/index.mjs install --host both --project-dir <path>   # 双装 (共享 .claude/skills/)
```

- `cc` 落 `.claude/` (settings.json + 4 个 hook .mjs + skill + 4 个 subagent)。
- `oc` 落 `.claude/skills/loop-engineering/` (OpenCode 原生读 Claude 兼容路径) + `.opencode/` (agents + plugin + opencode.json)。
- `both` 先装 CC 再装 OC, 两者共享同一份 `.claude/skills/SKILL.md`, 不冲突。

发布后将简化为一行全局安装:

```bash
npm install -g e2e-loop
e2e-loop install --host both --project-dir <path>
```

---

## CLI 命令族

资产管理:

| 命令 | 说明 |
| --- | --- |
| `install`   | 安装 Claude Code / OpenCode 资产到目标项目 (`--host`, `--project-dir`, `--force`, `--dry-run`) |
| `uninstall` | 卸载已安装资产 (只删本工具装的) |
| `list`      | 列出目标项目下本工具管理的资产 |

算法 dry-run (本地骨架验证, worker 用 echo 占位):

| 命令 | 说明 |
| --- | --- |
| `init`            | 建 run, 写 `input/requirement.md` + `run-state.json`, 打印 run_id |
| `status`          | 打印当前 phase / human_pending / active_tasks |
| `plan`            | 进入 PLANNING, 提交 design + task-plan |
| `run`             | IMPLEMENTING tick 循环, 跑到等人或终态 |
| `wrap-up`         | WRAPPING_UP 收口自检 |
| `signoff-plan`    | 人盯点 1: 接受 / 拒绝计划 (`--reject --feedback`) |
| `signoff-wrap-up` | 人盯点 2: 接受 / 拒绝收口 (`--reject`) |
| `abort`           | 任意 phase → ABORTED (必须给 `--reason`) |
| `amend`           | 处理 plan-amendment (回滚触及 AC 的 task, 回 PLANNING) |

完整选项见 `node packages/cli/dist/index.mjs help`。

---

### Worktree 选择

`e2e-loop init` 本身保持非交互: CLI 不弹 prompt, 只执行明确参数。真实 coordinator 在收到用户需求后、调用 init 之前, 应先询问是否为本次 run 使用隔离 git worktree, 再把选择显式传给 CLI:

| 用户选择 | CLI 参数 |
| --- | --- |
| 开启隔离 worktree (推荐) | `--worktree-mode auto` |
| 使用当前目录 | `--worktree-mode none` |
| 强制新建 worktree | `--worktree-mode always` |

宿主有 AskUserQuestions/AskUserQuestion 工具时用结构化提问框; 无该工具时用文本提问。若当前仓库有未提交改动, coordinator 应把 `--worktree-mode auto` 作为推荐选项置顶, 避免本次开发与用户当前修改混在一起。

---

## 架构

```
core/                宿主无关 SSOT (coordinator.md 提示词 + subagents/ + standards/ + manifest.json)
packages/            npm workspace 包
  ├── cli/           @e2e-loop/cli         — e2e-loop 命令 (install/uninstall/list + dry-run + dispatch)
  ├── adapter-cc/    @e2e-loop/adapter-claude-code — CC adapter (4 hook 编译为 .mjs)
  ├── adapter-oc/    @e2e-loop/adapter-opencode    — OC adapter (4 hook 等价 plugin bundle)
  ├── shared/        @e2e-loop/shared      — 跨 adapter 共享层 (hook logic / path_match / actual_writes)
  └── ssot-ts/       @e2e-loop/ssot        — TS 算法 SSOT (schema/state_machine/scheduling/checklists/...)
bin/                 e2e-loop wrapper (→ packages/cli/dist/index.js, 构建 后可用)
docs/                设计文档与规范源
```

- 同一份 hook 判断核心 (`packages/shared/src/hooks/*/logic.ts`) 被 CC binding 与 OC binding 共享, 保证两宿主决策一致 (设计 §5.2 / §6.1)。
- 架构全景见 [`docs/loop-engineering-cross-host-design.md`](docs/loop-engineering-cross-host-design.md); 算法/状态机细节见 [`docs/loop-engineering-collaborative-design.md`](docs/loop-engineering-collaborative-design.md)。

---

## 测试

TS SSOT 与跨宿主一致性 (设计 D-4: 测试运行时用 Bun):

```bash
npx bun test tests-ts/        # 全套 TS 测试 (等价测试 + 集成 + 跨宿主一致性)
npx tsc --noEmit              # 类型检查
```

---

## 迁移状态

源自设计 §11 路线图。`ssot-ts` 为唯一算法 SSOT; 原 Python `loop_engineering/` 包已于 2026-06-28 (用户决策) 物理移除, TS 等价测试守护行为对齐。

| 阶段 | 目标 | 状态 |
| --- | --- | --- |
| P0 | Monorepo 重构: 拆 `core/`, 建 `packages/` 与 `adapters/` 骨架 | ✅ |
| P1 | npm workspace 通; `@e2e-loop/{cli,adapter-claude-code,shared}` 全 TS; 4 hook TS 重写 | ✅ |
| P2 | `@e2e-loop/adapter-opencode` 基础: SKILL.md + subagent 落 OpenCode; CLI 接 host=oc/both | ✅ |
| P3 | OpenCode plugin: 4 hook 在 OC plugin 体系等价实现 (复用 shared logic) | ✅ |
| P4 | Python SSOT → TS 迁移 M1-M6 (schema → … → trust_mode), 全落 `packages/ssot-ts` (zod) | ✅ |
| P5 | M7 runtime/dispatch/cli 迁移; Python 包标记 deprecated; 文档全切 npm | ✅ |
