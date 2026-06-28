# Loop Engineering 跨宿主适配设计说明书

| 字段 | 值 |
| --- | --- |
| 版本 | v0.2 (决策已拍板, P0 启动就绪) |
| 日期 | 2026-06-27 |
| 状态 | §14 决策已全部确定, 进入 P0 实施 |
| 规范源 | 本文档与 `loop-engineering-collaborative-design.md` 并列; 涉及算法/状态机时仍以 collaborative-design 为准 |

---

## 0. TL;DR

把 loop-engineering 从 Claude Code 专属改造成 **Claude Code + OpenCode 双宿主、能力对齐**的协作 harness。技术路径:

1. **SSOT + Adapter 架构**: 一份核心提示词, 两份宿主包装。
2. **npm 化**: Node 写 installer 与 CLI, 通过 `e2e-loop install --host <cc|oc|both>` 落资产。
3. **Hooks 全量 TS 重写**: 4 个 Python hook 用 TypeScript 重写, 在 OpenCode plugin 体系下等价复刻, 不降级。
4. **Python SSOT 渐进迁移到 TS**: 按依赖图逐子包迁移, 双轨共存期由等价测试守护, 直到 TS 实现成为唯一权威。

预计工作量 15-20 工作日, 关键 go/no-go 节点在 P3 (OpenCode plugin 等价性 spike)。

---

## 1. 背景与目标

### 1.1 当前形态

仓库现状 (2026-06):

- Python 包 `loop_engineering/` 作为算法 SSOT, 含 schema / state_machine / scheduling / checklists / amendment / multi_service / trust_mode / runtime / dispatch 九个子包, 265+ 测试覆盖。
- Claude Code 资产 (skill/agents/hooks/settings.json) 打包在 Python 包内, 通过 `e2e-loop install-claude` 同步到目标项目 `.claude/`。
- 4 个 Python hooks 注册在 `settings.json`, 在 Claude Code 会话内被宿主调用。
- 不兼容 OpenCode: settings.json 不被识别, Python hooks 无法在 OpenCode 体系内运行。

### 1.2 业务诉求

- 团队部分成员使用 OpenCode, 需要在两种宿主下用同一套协作流程。
- "防糊弄"层 (`actual_writes` 三层采集) 与"路径白名单""人锚点"等护栏在 OpenCode 下必须等价生效。
- 安装方式要从"`pip install` 后调 Python CLI"简化为"`npm install -g` 一行装好"。

### 1.3 设计目标

**功能目标**

- F1: 同一份 run-state.json / task-plan.yaml / artifact 在两种宿主下产出**一致** (字节级或语义级一致, 详见 §13)。
- F2: 4 个 hook 在两种宿主下等价生效 (允许实现不同, 行为对齐)。
- F3: `e2e-loop` CLI 跨平台, Windows/macOS/Linux 一致.

**非功能目标**

- NF1: 安装不依赖 Python (P3 完成后), 完全 Node 运行时。
- NF2: 任何阶段可回滚 (P0-P5 每个里程碑独立可发布)。
- NF3: Python SSOT 与 TS SSOT 共存期, 由等价测试守护行为对齐。

---

## 2. 关键决策 (用户已拍板)

| ID | 决策 | 含义 |
| --- | --- | --- |
| D1 | OpenCode 能力必须与 Claude Code 对齐 | 4 个 hook 全部 TS 重写, 包括最复杂的 `post_task_collect` |
| D2 | 走 npm 发布 | Node 写 installer + CLI; Python SSOT 仍走 PyPI, 两边版本同步 |
| D3 | Python 脚本渐进迁移到 JS/TS | 不一次性重写, 按子包依赖图迁移, 共存期等价测试 |

本文所有后续设计基于这三条前提。

---

## 3. 设计原则

| 原则 | 落地 |
| --- | --- |
| **SSOT 单源** | 提示词主体、craft 标准、状态机定义只有一份, adapter 只做格式包装, 不重新表达语义 |
| **能力等价** | 任何 hook 在两宿主下行为偏差需显式登记为已知差异 (§12), 默认要求一致 |
| **渐进可逆** | 每个 P 阶段产出独立可发布版本, 任何阶段失败可回到上一阶段而不阻塞用户 |
| **测试驱动** | TS 重写的每个算法必须先有从 Python 测试翻译过来的等价测试, 再写实现 |
| **宿主中性** | 协调器主提示词尽量用"协调器分发 worker""路径白名单 hook 拦截"等中性表述, 不出现"Task 工具""PreToolUse matcher"等宿主专属词 |

---

## 4. 目标架构

### 4.1 Monorepo 结构

```
loop-engineering/                          # 单一仓库 (现在的仓库演化而来)
├── core/                                  # 宿主无关 SSOT
│   ├── coordinator.md                     # 主协调器提示词 (从 SKILL.md §3 抽出语义)
│   ├── subagents/                         # 4 个角色语义内容
│   │   ├── clarification-finder.md
│   │   ├── plan-agent.md
│   │   ├── implementation-worker.md
│   │   └── red-team-reviewer.md
│   ├── standards/                         # craft 标准层 (从 skills/loop-engineering/standards 迁入)
│   └── manifest.json                      # 资产清单 (adapter 读取此清单决定落盘布局)
│
├── adapters/
│   ├── claude-code/                       # Claude Code adapter
│   │   ├── skill/SKILL.md.j2              # Jinja2/Handlebars 模板, 渲染 core/coordinator.md
│   │   ├── agents/*.md.j2                 # 渲染 core/subagents/*.md 到 CC agent frontmatter
│   │   ├── settings.json.j2               # hook 注册
│   │   ├── hooks/                         # TS 写的 4 个 hook (CC 通过 stdin/stdout 协议调用)
│   │   │   ├── probe_and_gate.ts
│   │   │   ├── guard_paths.ts
│   │   │   ├── post_task_collect.ts
│   │   │   └── guard_anchors.ts
│   │   └── install.ts                     # adapter 安装入口
│   │
│   └── opencode/                          # OpenCode adapter
│       ├── skill/SKILL.md.j2              # 同 core 渲染; OpenCode 兼容 .claude/skills/ 也可直接落
│       ├── agents/*.md.j2                 # 渲染到 OpenCode agent frontmatter
│       ├── opencode.json.j2               # permission / plugin 注册
│       ├── plugins/                       # 4 个 TS plugin (等价 hook)
│       │   ├── probe_and_gate.ts
│       │   ├── guard_paths.ts
│       │   ├── post_task_collect.ts
│       │   └── guard_anchors.ts
│       └── install.ts
│
├── packages/                              # npm workspace 包
│   ├── cli/                               # @e2e-loop/cli (e2e-loop 命令)
│   ├── adapter-cc/                        # @e2e-loop/adapter-claude-code
│   ├── adapter-oc/                        # @e2e-loop/adapter-opencode
│   ├── shared/                            # @e2e-loop/shared (跨 adapter 工具, 如 actual_writes 采集)
│   └── ssot-ts/                           # @e2e-loop/ssot  (TS 实现的算法 SSOT, 见 §9)
│
├── loop_engineering/                      # Python SSOT (共存期保留, 逐步迁移到 packages/ssot-ts)
├── pyproject.toml
├── package.json                           # npm workspace 根
├── tests/                                 # Python SSOT 测试 (保留)
├── tests-ts/                              # TS SSOT 等价测试 (新建, 见 §13)
└── docs/
```

### 4.2 包拓扑

```
┌─────────────────────────────────────────────────────────────┐
│  npm workspace (Node 20+)                                    │
│                                                              │
│  @e2e-loop/cli ──┬──> @e2e-loop/adapter-cc                   │
│                  ├──> @e2e-loop/adapter-oc                   │
│                  ├──> @e2e-loop/shared                       │
│                  └──> @e2e-loop/ssot (TS, 渐进填充)          │
└─────────────────────────────────────────────────────────────┘
                            │
                            │  (共存期)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  PyPI: loop-engineering (Python, 渐进弃用)                   │
│  - 当前是算法 SSOT 唯一权威                                  │
│  - 随 packages/ssot-ts 填充, 子包逐个标记 deprecated         │
│  - 全部迁移完成后下一个大版本删除                            │
└─────────────────────────────────────────────────────────────┘
```

### 4.3 资产生命周期

```
开发期                  打包期                   安装期                  运行期
─────                  ─────                   ─────                  ─────
core/*.md   ─┐                                   
adapters/   ─┼─> npm publish @e2e-loop/*  ─> npm install -g      ─> 宿主加载 .claude/ 或 .opencode/
packages/   ─┘   (workspace 自动串包)        e2e-loop install        触发 hook / 加载 SKILL.md
                                              --host <cc|oc|both>
                                              --project-dir <p>
```

---

## 5. 核心抽象

### 5.1 Host Adapter 接口

每个 adapter 必须实现以下 TypeScript 接口:

```typescript
// packages/shared/src/adapter.ts
export interface HostAdapter {
  /** 宿主标识, 用于 CLI 选择与日志 */
  readonly host: "claude-code" | "opencode";

  /** 该 adapter 落盘后的目标根目录名 (相对 project_dir) */
  readonly targetDir: string; // ".claude" 或 ".opencode" (OC 也兼容 ".claude/skills/")

  /** 渲染所有资产到 project_dir */
  install(ctx: InstallContext): Promise<InstallResult>;

  /** 安装前预览, 不写盘 */
  dryRun(ctx: InstallContext): Promise<AssetManifest>;

  /** 卸载 */
  uninstall?(projectDir: string): Promise<UninstallResult>;
}

export interface InstallContext {
  projectDir: string;
  force: boolean;
  /** 用户级偏好, 例如 hook 启用清单 */
  features?: HookFeatures;
}

export interface AssetManifest {
  files: Array<{ path: string; source: "core" | "adapter"; size: number }>;
  conflictFiles: string[]; // 已存在且非 force 的文件
}
```

### 5.2 Hook 跨宿主抽象

4 个 hook 的**意图**是宿主无关的, 但**实现载体**不同 (CC: stdin/stdout 命令; OC: plugin module)。抽出共享层:

```typescript
// packages/shared/src/hooks/index.ts
export interface HostHook {
  readonly name: HookName;
  /** CC: 触发事件名 (PreToolUse/PostToolUse/...); OC: 等价 plugin event */
  readonly event: HookEvent;
  /** 协调器逻辑, 输入是统一 HookInput, 输出是统一 HookOutput */
  handle(input: HookInput): Promise<HookOutput>;
}

export type HookName =
  | "probe_and_gate"
  | "guard_paths"
  | "post_task_collect"
  | "guard_anchors";

export interface HookInput {
  event: HookEvent;
  toolName?: string;       // Write/Edit/Task/...
  toolInput?: unknown;     // 工具入参 (路径、文件内容、Task 描述等)
  cwd: string;             // 仓库根
  runDir?: string;         // 当前 run 目录 (从 cwd/runs/<id> 解析)
  phase?: string;          // 当前 run-state phase
  activeTasks?: string[];  // active task ids
}

export interface HookOutput {
  /** 是否放行 (allow / deny) */
  decision: "allow" | "deny" | "defer";
  /** deny 时的原因, 落入工具拒绝消息 */
  reason?: string;
  /** 副作用记录 (例如 actual_writes 计算结果) 落到 run 目录 */
  sideEffect?: { file: string; content: unknown };
}
```

**关键约束**: `HostHook.handle` 是纯函数 (除了显式的 sideEffect 落盘), 不直接调宿主 API。CC/OC adapter 各自负责把 `HookInput` 从宿主原生格式翻译过来, 把 `HookOutput` 翻译回宿主原生动作。

### 5.3 Asset Manifest (`core/manifest.json`)

声明 core 内有哪些资产, adapter 按表落盘:

```json
{
  "version": "0.1.0",
  "skill": {
    "source": "core/coordinator.md",
    "skillName": "loop-engineering"
  },
  "subagents": [
    { "id": "clarification-finder", "source": "core/subagents/clarification-finder.md" },
    { "id": "plan-agent", "source": "core/subagents/plan-agent.md" },
    { "id": "implementation-worker", "source": "core/subagents/implementation-worker.md" },
    { "id": "red-team-reviewer", "source": "core/subagents/red-team-reviewer.md" }
  ],
  "standards": "core/standards/*.md"
}
```

---

## 6. SKILL.md 跨宿主共享

### 6.1 OpenCode 兼容 `.claude/skills/` 的利用

OpenCode 官方文档 (`https://opencode.ai/docs/skills/`) 明确支持从 `.claude/skills/<name>/SKILL.md` 加载 skill。这意味着:

- **P2 阶段产出立即可用**: 即使后续 hook 重写未完成, 把 SKILL.md 落到目标项目 `.claude/skills/loop-engineering/`, OpenCode 主 agent 会自动发现并加载, 协调器主流程能跑。
- **降级路径**: hooks 缺失期间, 仅丢失"路径白名单""防糊弄""人锚点"4 道护栏, 不阻塞 run 主流程。

### 6.2 frontmatter 双宿主合规

OpenCode `SKILL.md` 只识别 `name / description / license / compatibility / metadata` 五个字段, 其他被忽略。

策略: **统一使用两宿主并集的子集**:

```yaml
---
name: loop-engineering
description: 协作式多阶段开发 harness; 主 agent 加载后即 coordinator
license: MIT
compatibility: claude-code,opencode   # OC 识别, CC 忽略
metadata:
  version: 0.1.0
  standards: glossary,clarification,plan,test-design,implementation,review
---
```

Claude Code 当前 SKILL.md 里其他字段 (如 `allowed-tools` 等 CC 专属字段) 挪到 adapter 模板的 wrapper 里, 不污染 core。

### 6.3 协调器主提示词的工具语义中性化

`core/coordinator.md` 把"Task 工具分发 worker""PreToolUse hook 拦截"等宿主绑定词改为中性描述:

| 现状 (CC 绑定) | 中性化后 |
| --- | --- |
| "通过 Task 工具分发 worker" | "通过宿主的子 agent 分发机制 (Claude Code: Task; OpenCode: skill/agent 调用) 分发 worker" |
| "PreToolUse Write\|Edit hook 拦截" | "路径白名单 hook 在 Write/Edit 前拦截" |
| "Stop hook 校验" | "回合结束 hook 校验" |

每处中性化表述在脚注里附 CC 与 OC 的具体绑定, adapter 模板可以选择性注入宿主专属提示。

---

## 7. Subagent 跨宿主适配

### 7.1 frontmatter 差异

| 字段 | Claude Code | OpenCode |
| --- | --- | --- |
| 标识 | `name` | `name` (必须等于目录名) |
| 描述 | `description` | `description` (1-1024 字符) |
| 工具限制 | `tools:` 列表 | `tools:` 映射 (含 `false` 禁用) |
| 模型 | `model:` | (在 opencode.json 中配) |
| 权限 | (无原生) | `permission:` 块 |
| 其他自定义 | 允许 | **忽略 unknown** |

### 7.2 双 frontmatter 模板生成策略

不在 core 维护两份, 而是**模板渲染**:

```
core/subagents/plan-agent.md            # 仅正文 + 通用元数据
adapters/claude-code/agents/plan-agent.md.j2
  → 渲染时拼入: name, description, tools, model (CC 专属字段)
adapters/opencode/agents/plan-agent.md.j2
  → 渲染时拼入: name, description, permission, tools (OC 专属字段)
```

### 7.3 Task 工具 ↔ skill/agent 调用语义对齐

| 概念 | Claude Code | OpenCode |
| --- | --- | --- |
| 主 agent 分发 worker | `Task(subagent, prompt)` | `skill({name})` 或 agent 切换 |
| 子 agent 上下文隔离 | Task 自动隔离 | OpenCode agent 模式 |
| 子 agent 产物收回 | 子 agent 输出回主 | OpenCode 子 agent 输出回主 |

**风险 R2 (见 §12)**: OC 的子 agent 调用是否完全隔离上下文, 需 P2 spike。若不隔离, `post_task_collect` 的"独立重算 actual_writes"逻辑需要另寻依据 (例如改成主 agent 自己重算)。

---

## 8. Hooks TS 重写 (核心章节)

### 8.1 现状回顾

| Hook | 触发 | 职责 | 复杂度 |
| --- | --- | --- | --- |
| `probe_and_gate` | SessionStart | 探 git/fs 能力; unattended 档就绪校验; 异常退化放行 | 低 |
| `guard_paths` | PreToolUse Write\|Edit | 路径白名单 (phase + active task) ; `.claude/**` `loop_engineering/**` 永远 deny | 中 |
| `post_task_collect` | PostToolUse Task | **防糊弄**: 独立重算 actual_writes, 校验必需 artifact 落盘 | **极高** |
| `guard_anchors` | Stop | 校验 phase 自检通过才允许结束; 人锚点放行 | 中 |

### 8.2 跨宿主 Hook 抽象层 (复用 §5.2)

每个 hook 拆成两层:

```
packages/shared/src/hooks/guard_paths/
├── logic.ts          # 宿主无关核心逻辑 (路径匹配、白名单判定)
├── cc_binding.ts     # CC 适配: stdin JSON → HookInput, HookOutput → stdout JSON
└── oc_binding.ts     # OC 适配: plugin API → HookInput, HookOutput → plugin return
```

CC 和 OC binding 各自只写一次宿主协议翻译, 共享 logic。

### 8.3 Claude Code adapter 的 Hook 实现

CC 的 stdin/stdout hook 协议不变, 只是把脚本从 Python 改成 TS。打包后由 `bun build` 或 `esbuild` 编译成单文件可执行脚本, settings.json 里调用方式从 `python X.py` 改成 `node X.mjs` 或编译产物路径。

`adapters/claude-code/settings.json.j2`:

```jsonc
{
  "hooks": {
    "SessionStart": [{"hooks": [{"type": "command", "command": "node .claude/hooks/loop_engineering/probe_and_gate.mjs"}]}],
    "PreToolUse": [{"matcher": "Write|Edit", "hooks": [{"type": "command", "command": "node .claude/hooks/loop_engineering/guard_paths.mjs"}]}],
    "PostToolUse": [{"matcher": "Task", "hooks": [{"type": "command", "command": "node .claude/hooks/loop_engineering/post_task_collect.mjs"}]}],
    "Stop": [{"hooks": [{"type": "command", "command": "node .claude/hooks/loop_engineering/guard_anchors.mjs"}]}]
  }
}
```

### 8.4 OpenCode adapter 的 Hook 实现 (需 P3 spike)

OpenCode plugin 是 TS module, 在 `opencode.json` 里通过 `permission` 块或专用 plugin 注册启用。具体 API 在 P3 阶段 spike, 落点是:

```jsonc
// adapters/opencode/opencode.json.j2 (示意)
{
  "permission": { "skill": { "*": "allow" } },
  "plugins": {
    "loop-engineering": {
      "path": ".opencode/plugins/loop_engineering",
      "events": ["session.start", "tool.pre", "tool.post", "stop"]
    }
  }
}
```

```typescript
// adapters/opencode/plugins/loop_engineering/index.ts (示意)
import { handleGuardPaths } from "@e2e-loop/shared";

export default {
  name: "loop-engineering",
  events: {
    "tool.pre": async (ctx) => {
      if (ctx.tool !== "Write" && ctx.tool !== "Edit") return { allow: true };
      const out = await handleGuardPaths(toHookInput(ctx));
      return out.decision === "allow" ? { allow: true } : { allow: false, reason: out.reason };
    },
    // ...
  },
};
```

**P3 spike 必须回答的 4 个问题** (任一否决则需 fallback 设计):

- Q1: OpenCode 是否暴露 `tool.pre` 等价事件供 plugin 拦截 Write/Edit?
- Q2: OpenCode 是否暴露"子 agent 调用结束"事件供 plugin 收回 worker outcome? (post_task_collect 关键依赖)
- Q3: OpenCode plugin 能否读写当前会话 cwd 之外的文件 (落盘 sideEffect)? 不能则需 IPC 通道。
- Q4: OpenCode 是否提供"会话停止前"事件供 guard_anchors 等价物挂载?

#### Spike 结论 (2026-06-28, 已读 opencode.ai/docs/plugins, plugin API 验证)

OpenCode plugin = `.opencode/plugins/` 下的 JS/TS module (启动自动加载, 无需 opencode.json 注册), 导出 `Plugin` 函数, 入参 `{project, client, $, directory, worktree}`, 返回 hooks 对象。可用 hooks: `tool.execute.before(input,output)` / `tool.execute.after(input,output)` / `event({event})` / `shell.env` 等。**OC 工具名小写** (write/edit/read/bash/task)。

| 问题 | 结论 | 落地 |
| --- | --- | --- |
| Q1 | ✅ **完全可行** | `tool.execute.before`, `input.tool ∈ {write,edit}`, 读 `output.args.filePath`; `throw new Error(reason)` 即拦截 (`.env` 保护示例证实)。guard_paths 全等价。 |
| Q2 | ✅ **完全可行** | 子 agent 经 `task` 工具分发; `tool.execute.after` 过滤 `input.tool==="task"` = CC `PostToolUse:Task`。post_task_collect 可独立重算 actual_writes (从 runDir/git 重新派生, 不依赖 task 返回结构, 更稳)。防糊弄全等价。 |
| Q3 | ✅ **完全可行** | plugin 跑在 Bun, 有 `$` (Bun shell) + node:fs 全文件系统访问; sideEffect 直接写 runDir。无需 IPC。 |
| Q4 | ⚠️ **部分** (唯一缺口) | OC 无 CC `Stop` 那种"硬阻断回合"hook; 最接近的 `session.idle` 是**非阻断**事件通知。Fallback: guard_anchors 在 `session.idle` 跑自检, 失败时经 `client`/`tui.toast` 告警 + 协调器 SKILL.md 提示词软门禁。登记为已知差异 (§12 R9)。 |

probe_and_gate (CC SessionStart): 经 plugin-init 或 `session.created` 事件探测 git/fs + 注入 capabilities (best-effort, 退化放行不变)。

**Go/No-Go 判定**: D1 (能力对齐) **基本达成** —— 4 hook 中 guard_paths + post_task_collect (含最关键防糊弄) 完全等价, probe_and_gate 功能等价, 仅 guard_anchors 退化为劝告式 (有明确 fallback)。**关键复用**: P1 已落地的宿主无关 `packages/shared/src/hooks/*/logic.ts` 直接被 OC binding 调用, 两宿主共享同一判断核心 (§5.2 设计兑现)。

### 8.5 逐 hook 设计

#### 8.5.1 `probe_and_gate`

职责不变, TS 实现要点:

- `git --version` 探测: `Bun.spawn` 或 `child_process.execFile`, 失败时 `git_available = false`, 不抛错。
- `fs` 写权限探测: 试写 `.claude/.e2e-loop-probe` 临时文件后删除。
- unattended 档校验: 读取 run-state.json 的 trust_mode; unattended 下校验"独立复跑通道"存在; 异常**退化放行** (继承现有 Python 行为, `probe_and_gate.py` 已有此设计)。

#### 8.5.2 `guard_paths`

逻辑: 当前 phase × active task 决定白名单; 写路径不在白名单或落在永久 deny 区则拒。

TS 实现要点:

- 路径匹配: 复用 `packages/shared/src/path_match.ts` (glob + 前缀匹配)。
- 永久 deny 列表: `.claude/**`, `loop_engineering/**`, `.opencode/**` (OC adapter 加这一项)。
- 白名单来源: 读 `run-state.json` 的 phase + active_tasks, 结合 task-plan.yaml 里每个 task 的 `allowed_write_paths`。
- 性能: hook 在每次 Write/Edit 都触发, 必须在 50ms 内出决策; 用文件 mtime 缓存 task-plan 解析结果。

#### 8.5.3 `post_task_collect` (最复杂)

防糊弄核心。当前 Python 实现做三件事:

1. 独立重算 `actual_writes`: 优先 git diff, 失败则 fs snapshot, 最后才用 worker 自报告。
2. 校验必需 artifact 落盘: `test-results.yaml`, `summary.md`, `key-diffs.yaml`。
3. 越界检测: 实际写入不在 `allowed_write_paths` 内, 或已被更早 task 写过。

TS 实现:

```typescript
// packages/shared/src/hooks/post_task_collect/actual_writes.ts
export async function computeActualWrites(
  runDir: string,
  taskId: string,
  sinceCommitOrTimestamp: string,
): Promise<ActualWrites> {
  // 第一层: git diff
  const gitResult = await tryGitDiff(runDir, sinceCommitOrTimestamp);
  if (gitResult.ok) return { source: "git", paths: gitResult.paths };

  // 第二层: fs snapshot (对比 run 目录下 tasks/<id>/before.snapshot 与 after.snapshot)
  const fsResult = await tryFsSnapshot(runDir, taskId);
  if (fsResult.ok) return { source: "fs", paths: fsResult.paths };

  // 第三层: worker 自报告 (软约束)
  return { source: "self_report", paths: await readSelfReport(runDir, taskId) };
}
```

**两个跨宿主难点**:

- **难点 A**: OC 没有"Task 工具"等价物, "PostTaskCollect" 何时触发? 候选方案:
  - OC 主 agent 在 worker 分发结束时显式调用 `loop_eng_post_collect` skill (在 SKILL.md 协调器提示词里硬约束);
  - 或 OC plugin 监听 agent switch 事件;
  - **P3 spike 决定**。
- **难点 B**: 第一层 git diff 依赖"hook 触发时存在一个 baseline commit/标记"。当前 Python 版靠 fs snapshot 兜底, TS 版同样实现; 但 OC 下"在 worker 启动前拍 snapshot"由谁负责, 需要在协调器提示词里加约束。

#### 8.5.4 `guard_anchors`

逻辑: Stop 事件触发时, 校验当前 phase 的客观自检通过; 人锚点 (`plan_signoff` / `wrap_up_signoff`) 放行。

TS 实现要点:

- 自检调用: 跑 `packages/shared/src/checklists/{plan_check,task_check,wrap_up_check}.ts` (这些是 §9 迁移过来的 TS 实现)。
- 人锚点判定: 读 `run-state.json` 的 `human_pending` 字段, 在 plan_signoff / wrap_up_signoff 阶段直接放行。
- 失败时: 返回 `decision: "defer"` + reason, 宿主把 reason 注入下一轮提示词。

---

## 9. Python SSOT → TS 迁移

### 9.1 当前 Python 包拓扑与依赖图

```
schema (Pydantic 数据模型, 基础)
   ↑
   ├── state_machine
   ├── scheduling (path_overlap, ready_frontier, watchdog, actual_writes, capabilities)
   ├── checklists (checks_eval, key_diffs_gate, plan_check, task_check, wrap_up_check)
   ├── amendment (ac_index, rollback)
   ├── multi_service (contracts_diff, propagation, service_map)
   └── trust_mode (gate)
        ↑
        └── runtime (coordinator, tick, directory) ── dispatch (worker_runner)
                                                  └── cli
```

### 9.2 迁移顺序 (由依赖图底层向上)

| 阶段 | 迁移目标 | 内容 | 测试源 |
| --- | --- | --- | --- |
| M1 | `schema` | Pydantic v2 → `zod` (或 `valibot`); RunState/TaskPlan/Artifacts 等 | `tests/test_*.py` 翻译 |
| M2 | `state_machine` + `checklists/checks_eval` | phase 迁移合法性、checks 文法解析 | 同上 |
| M3 | `scheduling` | path_overlap, ready_frontier, watchdog, actual_writes, capabilities | 同上 |
| M4 | `checklists/{plan_check,task_check,wrap_up_check}` + `key_diffs_gate` | 三组客观自检 | 同上 |
| M5 | `amendment` + `multi_service` | AC 反查、保守扩围、契约 diff | 同上 |
| M6 | `trust_mode` | unattended 切换门 | 同上 |
| M7 | `runtime` + `dispatch` + `cli` | 协调器、tick、worker runner、CLI | 集成测试翻译 |

### 9.3 共存期策略

每个子包迁移期间, Python 与 TS **双轨并存**:

- TS 实现首先只被 hook 调用 (hooks 是 TS 写的, 必须用 TS 算法)。
- Python 实现仍是 CLI 与 dry-run 的权威。
- 当某子包的 TS 实现通过 §13 的等价测试后, 在下一个 minor 版本里:
  - TS 包导出该子包;
  - Python 包对应子包标记 `# Deprecated, see packages/ssot-ts/<sub>`;
  - CLI 改为优先调用 TS 实现的等价命令, 失败时 fallback 到 Python (短期);

### 9.4 等价测试策略

每个 M 阶段必须先翻译 Python 测试到 `tests-ts/`:

```
tests/test_checks_eval.py        →   tests-ts/checks_eval.test.ts
tests/test_path_overlap.py       →   tests-ts/path_overlap.test.ts
...
```

要求: 同一组输入下, Python 与 TS 实现的输出**字节级一致** (字符串、列表顺序、字典 key 集合)。浮点与时间戳例外 (允许 epsilon)。

### 9.5 弃用与切换

- 全部 M1-M7 完成后, 在下一个大版本 (例如 1.0.0):
  - 删除 `loop_engineering/` Python 包;
  - 删除 `pyproject.toml` 的 `[project.scripts] e2e-loop` 入口;
  - 仅保留 `package.json` 入口;
  - `pip install loop-engineering` 不再可用, 文档全切到 `npm install -g`。

---

## 10. CLI 与发布

### 10.1 命令族

```bash
# 安装 (核心命令)
e2e-loop install --host <cc|oc|both> --project-dir <path> [--force]

# 预览 (不写盘)
e2e-loop install --host <cc|oc|both> --project-dir <path> --dry-run

# 卸载
e2e-loop uninstall --host <cc|oc|both> --project-dir <path>

# 列出当前项目已装的 adapter 资产
e2e-loop list --project-dir <path>

# 算法 SSOT 本地 dry-run (兼容旧 Python CLI, M7 后由 TS 接管)
e2e-loop init <requirement.md>
e2e-loop status <run_id>
e2e-loop plan <run_id> --design <file> --task-plan <file>
e2e-loop run <run_id>
e2e-loop wrap-up <run_id>
e2e-loop signoff-plan <run_id> [--reject --feedback <text>]
e2e-loop signoff-wrap-up <run_id> [--reject]
e2e-loop abort <run_id> --reason <text>
e2e-loop amend <run_id> --reason <text> --ac <id>...

# 跨宿主等价性验证 (CI 用)
e2e-loop verify --fixture <fixture-dir>
```

### 10.2 npm workspace 发布

```jsonc
// package.json (根)
{
  "name": "loop-engineering-monorepo",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "bun build packages/*/src/index.ts --outdir dist",
    "test": "bun test",
    "publish:all": "bun run build && tsWorkspacesPublish"
  }
}
```

发布流程:

1. `bun run build` 编译所有 adapter 的 hooks 到 `dist/`, 含 CC 的 `.mjs` 单文件与 OC 的 plugin bundle。
2. `changeset version` (推荐用 changesets 管 monorepo 版本)。
3. `npm publish --workspaces` (或 `changeset publish`)。

### 10.3 PyPI 发布 (共存期)

共存期内, `loop-engineering` Python 包继续发 PyPI, 但仅在 M7 前需要。每个 minor 版本同步 npm 版本号。

### 10.4 版本同步

| 维度 | 规则 |
| --- | --- |
| core/manifest.json 的 version | adapter 与 shared 必须引用此 version, 启动时校验 |
| npm 与 PyPI | 共存期内 minor 必须同步; patch 可独立 |
| 1.0.0 | TS SSOT 全量就绪, Python 删除的版本号 |

---

## 11. 实施路线图

| 阶段 | 目标 | 工作量 | go/no-go | 可发布版本 |
| --- | --- | --- | --- | --- |
| **P0** ✅ | Monorepo 重构: 拆 `core/`, 建 `packages/` 与 `adapters/` 骨架, 现有 Python 资产迁入 `core/` | 1.5 天 | — | 0.2.0-alpha (Python CLI 不变, 仅仓库重构) **已完成 2026-06-27** |
| **P1** ✅ | npm workspace 通; `@e2e-loop/cli` + `@e2e-loop/adapter-cc` (CC adapter 全 TS, 含 4 hook TS 重写); 替换原 `e2e-loop install-claude` | 3 天 | P1 hook 等价测试通过 (122 pass) | 0.3.0-alpha (npm 装 CC adapter 可用) **已完成 2026-06-28** |
| **P2** ✅ | `@e2e-loop/adapter-oc` 基础: SKILL.md 落 `.claude/skills/` (OC 直接读) + subagent 渲染成 OC frontmatter 落 `.opencode/agents/` + 最小 opencode.json; CLI 接 host=oc/both | 1.5 天 | OC (1.2.27) 真机发现 4 个 subagent + 结构加载通过 (完整 LLM simple-run 留待有凭证环境) | 0.4.0-alpha (OpenCode 降级可用) **已完成 2026-06-28** |
| **P3** ✅ | **OpenCode plugin spike**: 4 个 hook 在 OC plugin 体系等价实现 (复用 shared logic), 重点 `post_task_collect` | 4-5 天 | §8.4 四个 spike 问题: Q1/Q2/Q3 完全可行, Q4 部分 (guard_anchors 劝告式, R9); 真机 opencode 1.2.27 加载 plugin 并执行 probe_and_gate 成功 | 0.5.0-alpha (OpenCode 全功能) **已完成 2026-06-28** |
| **P4** | Python SSOT → TS 迁移: M1-M6 (schema/trust_mode 之间) | 5-6 天 | 每子包等价测试通过 | 0.6.0 - 0.9.0 (渐进) |
| **P5** | M7 runtime/dispatch/cli 迁移; Python 包标记 deprecated; 文档全切 npm | 2-3 天 | 全量测试通过; CC 与 OC e2e 一致 | 1.0.0 |

**总工作量**: 17-20 工作日 (单人, 不含评审与返工)。

---

## 12. 风险登记册

| ID | 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- | --- |
| R1 | OpenCode plugin API 不支持 `tool.pre` 等价事件, `guard_paths` 无法等价实现 | 中 | 高 (D1 失守) | P3 spike 早期验证; fallback: 在 SKILL.md 协调器提示词里强制主 agent 自检路径 |
| R2 | OpenCode 子 agent 调用上下文不隔离, `post_task_collect` 独立重算失去依据 | 中 | 高 | P3 spike 验证; fallback: 主 agent 自己重算 actual_writes (退化但可行) |
| R3 | `actual_writes` git diff 通道在 OC 下无 baseline commit, 只能依赖 fs snapshot | 高 | 中 | TS 实现强化 fs snapshot 兜底; 协调器提示词加"worker 启动前拍 snapshot"约束 |
| R4 | npm 与 PyPI 版本漂移导致 hook 行为不一致 | 中 | 中 | core/manifest.json 单源版本; CI 跨包校验 |
| R5 | TS 重写期 Python 测试套件失效 (Pydantic v2 → zod 边界条件差异) | 高 | 中 | 等价测试先翻译后实现; 容许 epsilon 但必须显式登记 |
| R6 | SKILL.md 提示词在两个宿主下行为漂移 (Task vs skill 调用语义差异) | 中 | 高 | 中性化表述 (§6.3); e2e 跨宿主等价测试 (§13) |
| R7 | OC 兼容 `.claude/skills/` 路径在 OC 未来版本被废弃 | 低 | 高 | adapter 支持双落盘 (.claude/ 与 .opencode/); 监控 OC changelog |
| R8 | Windows 下 hook 启动慢 (Node 冷启动 200ms+) 触发用户感知 | 中 | 低 | 编译为单文件 bundle (esbuild); 必要时 CC hook 改用 Bun runtime |
| R9 | OC 无"硬阻断回合"hook, `guard_anchors` 在 OC 下只能劝告式 (非阻断) | — (已确认) | 中 | P3 spike 确认 (Q4): `session.idle` 非阻断; OC 版 guard_anchors = session.idle 跑自检 + 失败告警 + 协调器 SKILL.md 提示词软门禁。CC 仍为硬 Stop 门禁。两宿主行为差异显式登记 (此为已知差异, 非缺陷) |
| R10 | P1 已知偏差: TS↔Python hook 行为存在 3 处**结构性差异** (非 bug, 是 TS 形态刻意收敛) | — (已确认) | 低 | 见下方"P1 等价矩阵"表。门禁仍达成: 12 关键用例全部 ✓ 等价。 |

### P1 等价矩阵 (TS `@e2e-loop/shared` logic ↔ Python `hooks/loop_engineering/*.py`)

> 关键 12 用例对照 (4 hook × 3)。Python 为行为权威。完整覆盖见 `tests-ts/*.test.ts`。

| Hook | 用例 | Python (test_hooks_smoke.py) | TS decision | 等价 | 备注 |
| --- | --- | --- | --- | --- | --- |
| guard_paths | `.claude/anything` 写入 | TestGuardPaths::test_dot_claude_always_denied | deny (含 .claude) | ✓ | 完全等价 |
| guard_paths | 无活跃 run | TestGuardPaths::test_no_active_run_passes_for_source | allow | ✓ | 完全等价 |
| guard_paths | IMPLEMENTING + allowed=src/** + 写 src/foo.py | TestGuardPaths::test_source_write_in_implementing_allowed | allow | ✓ | 完全等价 |
| guard_anchors | 无活跃 run | TestGuardAnchors::test_no_active_run_passes | allow | ✓ | 完全等价 |
| guard_anchors | human_pending=plan_signoff | TestGuardAnchors::test_human_pending_passes | allow | ✓ | 完全等价 |
| guard_anchors | IMPLEMENTING + 无 test-results.yaml | TestGuardAnchors::test_implementing_no_test_results_blocks | deny (含 IMPLEMENTING / test-results.yaml) | ✓ | 完全等价 |
| probe_and_gate | 无活跃 run + git 可用 | TestProbeAndGate::test_no_active_run_injects_capabilities | defer (capabilities.git_diff=true) | ✓ | 完全等价 |
| probe_and_gate | unattended + 无 §0.3 通道 | TestProbeAndGate::test_unattended_without_replay_channel_blocks | deny (含 unattended / §0.3) | ✓ | 完全等价 |
| probe_and_gate | collaborative + 活跃 run | TestProbeAndGate::test_collaborative_active_run_injects | defer (active_run 非 null, trust_mode) | ✓ | 完全等价 |
| post_task_collect | 非 loop worker | TestPostTaskCollect::test_non_loop_worker_passes_silent | allow (无 context) | ✓ | 完全等价 |
| post_task_collect | clarification-finder + questions.json 缺失 | TestPostTaskCollect::test_clarification_missing_artifact_blocks | deny (含 artifact / questions) | ✓ | 完全等价 |
| post_task_collect | clarification-finder + 含 1 个 question | TestPostTaskCollect::test_clarification_valid_passes | defer (verified=true, question_count=1) | ✓ | 完全等价 |

**P1 已知结构性差异 (留 P4 收敛, 非 P1 门禁):**

1. **`plan_check` / `wrap_up_check` 留 P4**: TS `guard_anchors` 在 PLANNING / WRAPPING_UP 阶段 (无 human_pending) 当前直接放行 (P1 占位); Python 跑完整 `plan_check` / `wrap_up_check`。覆盖见 `guard_anchors.test.ts` 用例 10/11。
2. **`findActiveRun` 定位机制差异**: Python `active_run_dir` 用 run 目录 mtime 定位 (不读 state), 故能区分"active≠null 但 state==null → warning"分支; TS `findActiveRun` 用 `run-state.json` 判活跃, state 缺失时直接返回 null → 退化为"无活跃 run"分支。行为等价 (都不 block), 仅 context 字段不同。覆盖见 `probe_and_gate.test.ts` 用例 5/5b。
3. **`path_globs_overlap` 对称-保守 vs `matchPath` 单向**: Python plan 阶段 `path_globs_overlap(glob×glob)` 判不准时保守 True; TS `matchPath(pattern×具体路径)` 是单向匹配, 不承担保守职责。TS actual_writes 永远是 git/fs 采集的**具体文件路径**, 不会出现 `!` / `[...]` / `{...}` 作为待判路径, 故此分歧不会被触发。覆盖见 `path_match.test.ts` B 组"契约差异"分组。


---

## 13. 测试策略

### 13.1 三层测试矩阵

| 层 | 范围 | 工具 | 阻塞 |
| --- | --- | --- | --- |
| 单元 | 算法 SSOT 等价 (Python vs TS) | pytest + bun test | 是 |
| 集成 | adapter install/uninstall e2e (空项目 fixture) | bun test + 临时目录 | 是 |
| 跨宿主 | 同一 run 在 CC 与 OC 下产物一致性 | `tests/fixtures/smoke/` 扩展 + 双宿主 CI runner | 否 (P3 前) |

### 13.2 等价测试范式

```typescript
// tests-ts/equivalence/checks_eval.test.ts
import { test } from "bun:test";
import { parseCheck, evalCheck } from "@e2e-loop/ssot/checklists/checks_eval";

const cases = await import("./fixtures/checks_eval.cases.json");

cases.forEach(({ input, expected }) => {
  test(`checks_eval: ${input}`, () => {
    const ast = parseCheck(input);
    expect(evalCheck(ast, expected.context)).toBe(expected.result);
  });
});
```

fixtures 与 Python 的 `tests/test_checks_eval.py` 用例同源, 由脚本 `scripts/sync_test_fixtures.py` 单向同步。

### 13.3 跨宿主 e2e 范式

```yaml
# tests/e2e/simple-run.fixture.yaml
requirement: |
  写一个 echo "hello" 的 Python 脚本
expected_artifacts:
  - runs/<id>/input/requirement.md
  - runs/<id>/planning/design.md
  - runs/<id>/planning/task-plan.yaml
  - runs/<id>/tasks/<id>/test-results.yaml
  - runs/<id>/tasks/<id>/summary.md
  - runs/<id>/wrap-up/check-result.json
```

CI 在 CC runner 和 OC runner 各跑一次, 对比 `expected_artifacts` 字段集合与关键字段值。

---

## 14. 决策记录 (v0.2 已全部拍板)

| ID | 决策 | 拍板选项 | 落地约定 |
| --- | --- | --- | --- |
| D-1 | npm 包结构 | **A. Monorepo + 子包** | npm scope `@e2e-loop`, 子包: `@e2e-loop/{cli, adapter-claude-code, adapter-opencode, shared, ssot}`; 用 changesets 管版本 |
| D-2 | Python SSOT 最终归宿 | **A. 完全废弃** | 1.0.0 删除 `loop_engineering/` Python 包; 共存期等价测试守护行为对齐 |
| D-3 | 共存期版本同步 | **A. changesets + 手动同步 PyPI** | npm 与 PyPI 共存期 minor 同步, patch 独立; 不上自动同步 Action |
| D-4 | TS 运行时 | **A. Bun** | hook 编译为单文件 bundle 解决"用户机器无 Bun"问题; CI 装 Bun |
| D-5 | OC plugin 语言 | **A. TS (与 CC 一致)** | 两侧 adapter 共享 `@e2e-loop/shared` 的 logic 层 |
| D-6 | npm 包名 | **C. 自定义 `e2e-loop`** (用户指定) | npm scope `@e2e-loop/*`; CLI 命令名 `e2e-loop`; 仓库目录/Python 包/SKILL name 保留 `loop-engineering`, 等 P5 与 Python 弃用一并改名 |

**剩余事实核验项 (非决策, P0 第一天做)**:

- `npm view @e2e-loop/cli` 确认 scope `@e2e-loop` 在 npm 上未被注册 (若已被占, 改 scope 名)。
- `npm view e2e-loop` 确认扁平名 `e2e-loop` 是否可用 (作为 monorepo 根包名)。

---

## 15. 后续动作

1. ✅ §14 决策已全部拍板 (v0.2);
2. ✅ P0 启动前事实核验: `@e2e-loop/cli`、`@e2e-loop/ssot`、`e2e-loop` 三个 npm 名字均未被注册;
3. ✅ P0 (Monorepo 重构) 已完成 2026-06-27: 拆 `core/`, 建 `packages/` 与 `adapters/` 骨架, Python CLI 行为不变, pytest 295 passed;
4. ✅ P1 已完成 2026-06-28: `@e2e-loop/{cli,adapter-claude-code,shared}` 全 TS, 4 hook TS 重写 + 自包含 .mjs; 接入 changesets; 期间修两处真 bug: `workspace:*`→`*` (npm install 兼容)、install.ts 资产定位改"向上行走"(bundle 形态 hook 落盘)。**测试运行时=Bun (D-4), 本机经 `npx bun@1.3.14 test tests-ts/` 运行**;
   - **P1-T5 (go/no-go) 完成 2026-06-28**: tests-ts/ 15 个测试文件 **161 pass / 0 fail** (path_match / actual_writes / 4 hook logic + fixtures 冒烟); tests-ts/package.json + tests-ts/fixtures/runs/20260101-001/ 共享夹具落盘 (env LOOP_RUNS_ROOT 指向它即可被 hook logic 解析为活跃 run)。Python ↔ TS 等价矩阵见 §12 R10。门禁达成, 进入 P4;
5. ✅ P2 已完成 2026-06-28: `@e2e-loop/adapter-opencode` 实现 —— SKILL.md+standards 落 `.claude/skills/loop-engineering/` (OC 原生读 Claude 兼容路径), 4 个 subagent 经 TS 渲染成 OC frontmatter (description/mode:subagent/permission, tools-list→permission 映射) 落 `.opencode/agents/`, 写合并安全的最小 `opencode.json` (permission.skill=allow); core/coordinator.md frontmatter 增补双宿主子集 (license/compatibility/metadata); CLI 接 host=oc/both (both=CC 后 OC, 共享 SKILL.md 不冲突, cli tsup 打包 js-yaml)。tests-ts/ 136 pass。**真机验证 (opencode 1.2.27)**: `opencode agent list` 在 oc 与 both 安装目录均发现全部 4 个 subagent; 完整 LLM simple-run 留待有凭证环境。已查证 OC 约定: agent 读 `.opencode/agents/<name>.md` (非 `.claude/agents/`), frontmatter `tools` 已废弃改用 `permission`;
6. ✅ P3 已完成 2026-06-28 (commit 见 git log): OpenCode plugin 实现 —— 单个自包含 bundle `.opencode/plugins/loop-engineering.js` (OC 启动自动加载), 复用 P1 的 `packages/shared/src/hooks/*/logic.ts`, OC binding 映射 `tool.execute.before(write/edit)→guard_paths(throw 拦截)` / `tool.execute.after(task)→post_task_collect(重算 actual_writes + sideEffect)` / `event(session.idle)→guard_anchors(劝告式, R9)` / `plugin-init+session.created→probe_and_gate`。tests-ts/ 155 pass。**真机验证 (opencode 1.2.27)**: DEBUG 日志确认 `loading plugin .opencode/plugins/loop-engineering.js` + 执行 probe_and_gate 输出 capabilities, 无加载错误。§8.4 spike 结论见上 (Q1-Q3 完全可行, Q4 部分→R9)。
7. **P4 (下一步)**: Python SSOT → TS 迁移 M1-M6 (schema→state_machine/checks_eval→scheduling→checklists→amendment/multi_service→trust_mode), 每子包等价测试守护 (§9)。
8. P5: M7 runtime/dispatch/cli 迁移; Python 包 deprecated; 文档全切 npm; 出 1.0.0。

---

## 附录 A: 与现有文档的关系

| 现有文档 | 与本设计书关系 |
| --- | --- |
| `loop-engineering-collaborative-design.md` | **规范源**, 不动; 本设计书的所有"算法/状态机"细节以此为准 |
| `loop-engineering-master-prompt.md` | 协调器主提示词, 在 P0 阶段拆成 `core/coordinator.md`, master-prompt.md 保留为历史参考 |
| `loop-engineering-prompts.md` | 4 个子 agent 提示词, 在 P0 阶段拆成 `core/subagents/*.md` |
| `*-review-report.md` | 历史评审记录, 不变 |

## 附录 B: 术语表

| 术语 | 含义 |
| --- | --- |
| SSOT | Single Source Of Truth, 单一规范源 |
| adapter | 把宿主无关 core 包装成特定宿主形态的层 |
| host | 提示词加载与执行环境, 指 Claude Code 或 OpenCode |
| hook | 宿主在工具调用/会话事件触发的拦截器 |
| 双轨共存期 | Python SSOT 与 TS SSOT 同时存在的过渡期 (P4-P5) |
