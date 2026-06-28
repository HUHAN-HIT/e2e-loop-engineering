# CLI Hook 入口改造设计

## 背景

Claude Code 旧安装会把 hook 写成项目内相对路径：

```json
"command": "node .claude/hooks/loop_engineering/probe_and_gate.mjs"
```

这要求 hook 进程的 `cwd` 正好是项目根目录，也要求复制到业务项目里的 `.mjs` 文件始终存在。为了减少路径依赖，Loop Engineering 需要提供稳定 CLI 入口，让 Claude Code hook 可以调用已安装的 `e2e-loop`。

OpenCode 的情况不同：它不是 stdin/stdout hook，而是通过 `.opencode/plugins/loop-engineering.js` 里的 plugin API 生效。因此 OpenCode 不应该要求用户在 hook 命令里指定宿主；OpenCode 的宿主适配应留在 plugin 层。

## 最终决策

采用“宿主由安装/适配层选择，hook CLI 不暴露宿主参数”的方案。

Claude Code：

```text
e2e-loop hook probe-and-gate
e2e-loop hook guard-paths
e2e-loop hook post-task-collect
e2e-loop hook guard-anchors
```

OpenCode：

```text
.opencode/plugins/loop-engineering.js
```

OpenCode plugin 继续负责把 OpenCode 的 `tool.execute.before`、`tool.execute.after`、`event` 等宿主事件翻译为 shared hook 输入。CLI 的 `hook` 子命令当前只承载 Claude Code stdin/stdout 协议，不接收 `cc`、`oc` 或其它宿主参数。

## 目标

1. 为 Claude Code 提供稳定 CLI hook 入口，避免 settings 依赖项目内相对 `.mjs` 路径。
2. 保留本地 `.mjs` hook 作为 fallback，兼容未安装 CLI 或需要离线复制入口的项目。
3. OpenCode 继续通过 plugin 生效，不把宿主选择泄露给用户配置。
4. 四个 hook 继续复用 shared hook 逻辑，避免 CLI 模式与本地 `.mjs` 模式行为分叉。
5. 修正 CLI 构建产物与 package/bin/test 的 `dist/index.js` 契约。

## 非目标

- 不重写 shared hook 决策逻辑。
- 不把 OpenCode plugin 改造成用户可见的 `e2e-loop hook oc ...` 命令。
- 不移除 Claude Code 本地 `.mjs` fallback。
- 不给 CLI 增加交互式 prompt。

## 命令契约

新增命令：

```text
e2e-loop hook <hook-name>
```

支持 hook 名称：

- `probe-and-gate`，别名 `probe_and_gate`
- `guard-paths`，别名 `guard_paths`
- `post-task-collect`，别名 `post_task_collect`
- `guard-anchors`，别名 `guard_anchors`

行为：

- stdin：Claude Code 原始 hook payload JSON。
- stdout：Claude Code hook stdout 协议。
- allow：空 stdout。
- deny：`{"decision":"block","reason":"..."}`。
- defer：`hookSpecificOutput.additionalContext`。
- 未知 hook：stderr 写 `未知 hook`，exit code 为 `1`。

## 安装模式

扩展 install 参数：

```text
e2e-loop install --host <cc|oc|both> --hook-mode <local|cli|auto> --cli-command <command>
```

Claude Code：

- `local`：默认模式，写入 `node .claude/hooks/loop_engineering/<name>.mjs`。
- `cli`：写入 `<cli-command> hook <hook-name>`，`cli-command` 默认 `e2e-loop`。
- `auto`：当前实现仅在提供 `--cli-command` 时选择 CLI，否则回退 local，避免重新安装时意外改变既有项目行为。

OpenCode：

- 继续安装 `.opencode/plugins/loop-engineering.js`。
- `--hook-mode` 不改变 OpenCode 的用户可见 hook 命令，因为 OpenCode 的 hook 生效面是 plugin。

重新安装切换 Claude Code hook 模式时，installer 会先移除已有 Loop Engineering hook 命令，再插入当前模式的四条命令，避免同时残留 local 和 cli 两套 hook。

## 运行时分层

```text
packages/cli/src/commands/hook.ts
packages/adapter-cc/src/hook_dispatcher.ts
packages/adapter-cc/src/runtime.ts
packages/shared/src/hooks/*/logic.ts
```

职责：

- `commands/hook.ts`：解析 `hook <hook-name>`，不解析宿主参数。
- `hook_dispatcher.ts`：规范化 hook 名称，读取 Claude Code stdin，构造 shared `HookInput`，调用对应 shared handler。
- `runtime.ts`：负责 Claude Code stdin/stdout 协议和 sideEffect 落盘。
- `shared`：保持宿主无关 hook 决策逻辑。

四个 Claude Code `.mjs` fallback 入口也复用同一个 dispatcher，因此 CLI 模式和本地模式共享执行路径。

## 发布契约

CLI 构建产物统一为：

```text
packages/cli/dist/index.js
```

对应契约：

- `@e2e-loop/cli` 的 `bin.e2e-loop` 指向 `dist/index.js`。
- `@e2e-loop/cli` 的 `main` 指向 `./dist/index.js`。
- root package 是私有 workspace，不直接发布；发布使用 workspace 包发布脚本。
- `@e2e-loop/adapter-opencode` 的 package API 入口仍是 `dist/index.mjs`，OpenCode plugin bundle 仍是 `dist/loop-engineering.js`。

## 测试覆盖

新增/更新测试覆盖：

1. `e2e-loop hook <name>` 可接收 Claude Code stdin。
2. 下划线 hook 别名与短横线名称一致。
3. 未知 hook 返回 exit code `1`。
4. `--hook-mode cli --cli-command e2e-loop` 生成无宿主参数的 Claude Code settings。
5. local 与 cli 模式切换不会残留旧 Loop Engineering hook。
6. 原有 `.mjs` hook E2E 继续通过。
7. install cc / oc / both E2E 继续通过。
8. workspace 发布契约对齐 `dist/index.js`。

## 验收标准

- `npm run build` 通过。
- `npm run typecheck` 通过。
- 聚焦 hook/install/publish 契约测试通过。
- Claude Code CLI 模式 settings 中只出现 `e2e-loop hook <hook-name>`，不出现 `hook cc` 或 `hook oc`。
- OpenCode 安装仍通过 plugin 生效，不需要用户配置宿主参数。
