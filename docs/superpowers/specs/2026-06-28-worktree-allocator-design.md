# Worktree Allocator 能力设计

## 背景

当前 Loop Engineering 已经有 run 目录、dispatch packet、actual writes 采集和 hook 入口，但“代码真实工作目录”仍然隐含在 `path.dirname(runDir)` 这类默认推导里。

这会带来两个问题：

1. 当主工程存在未提交改动时，worker 在同一个目录开发，容易和用户当前修改混在一起。
2. 当未来希望“一次 run 对应一个隔离开发空间”时，现有 `WorkerPacket.workdir`、capability probe、actual writes、hook cwd 和 run artifacts 没有统一的绑定来源。

Worktree allocator 的目标是把“这个 run 应该在哪个物理代码目录工作”变成 Loop Engineering 的一等能力，而不是依赖人工手动创建 worktree 或外部 skill 的隐式约定。

## 当前事实

现有代码里已有几个天然接入点：

- `WorkerPacket.workdir` 已经是 worker 的实际工作目录字段。
- `buildPacket(..., options.workdir)` 支持显式覆盖，未传时默认 `path.dirname(runDir)`。
- `Coordinator.dispatchReadyTasks()` 当前构造 packet 时未传 workdir。
- `probeCapabilities()` 当前在 coordinator 构造阶段用 `path.dirname(runDir)` 探测 git/fs 能力。
- `collectOutcome()` 依赖 packet 里的 `workdir` 做 git diff / fs snapshot / actual writes 判断。
- `service_map.ts` 已有 service 到 worktree 路径的轻量映射，但它只解析和校验已有路径，不创建真实 git worktree。
- Claude Code hook 已有 CLI 入口；OpenCode 仍通过 plugin 生效。

因此 allocator 不应该重写调度器，而应该给调度器提供一个稳定的 `workdir` 绑定。

## 最终决策

采用 **run-level worktree allocator**。

一个 Loop Engineering run 绑定一个物理 worktree。该 run 下的所有 worker dispatch、hook、actual writes、capability probe、collect outcome 都使用同一个绑定目录。

一期不做 per-task worktree。每个 task 一个 worktree 虽然隔离更强，但会立即引入多分支合并、冲突归并、重复依赖安装、hook 配置复制和 cleanup 风险。run-level allocator 能先解决路径一致性和用户工作区污染问题，复杂度更可控。

## 目标

1. 在 run 初始化阶段创建或绑定一个 git worktree。
2. 把该 worktree 写入可审计的 binding artifact。
3. 让 coordinator、dispatch packet、capability probe、actual writes 统一读取 binding。
4. 让 hook 在 worktree cwd 下也能找到 run artifacts 和项目级配置。
5. 默认保持现有行为，只有显式开启 worktree mode 才改变物理目录。
6. cleanup 只处理 allocator 自己创建且安全可删除的 worktree。

## 非目标

- 不实现 task-level worktree。
- 不自动 merge 回原分支。
- 不自动解决 git 冲突。
- 不自动修改 `.gitignore`。
- 不把 OpenCode plugin 改成用户可见的 `e2e-loop hook oc ...` 命令。
- 不让 runtime 依赖 Codex/Superpowers 的 `using-git-worktrees` skill；该 skill 只作为人工流程参考。

## 命令契约

在创建 run 的命令上增加 worktree 参数：

```text
e2e-loop init <requirement> \
  --worktree-mode <none|auto|always|adopt> \
  --worktree-root <path> \
  --worktree-path <path> \
  --branch-prefix <prefix> \
  --base <ref>
```

参数语义：

- `--worktree-mode none`：默认值。保持现有行为，不创建也不绑定 worktree。
- `--worktree-mode auto`：优先绑定当前目录；如果当前不是隔离 worktree，则创建新 worktree。
- `--worktree-mode always`：必须创建新 worktree，失败则中止。
- `--worktree-mode adopt`：绑定 `--worktree-path` 指定的已有目录，不创建新 worktree。
- `--worktree-root`：新建 worktree 的父目录，默认 `.worktrees`。
- `--worktree-path`：adopt 模式必填；always 模式下可用于显式指定目标路径。
- `--branch-prefix`：新建分支前缀，默认 `loop/`。
- `--base`：新 worktree 的基准 ref，默认 `HEAD`。

后续可增加维护命令：

```text
e2e-loop worktree status <run-id>
e2e-loop worktree cleanup <run-id>
e2e-loop worktree adopt <run-id> --worktree-path <path>
```

一期只要求 init/start 路径能产出 binding；维护命令可以分阶段实现。

## Binding Artifact

新增文件：

```text
runs/<run_id>/worktree-binding.json
```

文件形状：

```json
{
  "schema": "loop-engineering.worktree-binding.v1",
  "mode": "created",
  "owner": "loop-engineering",
  "repo_root": "E:/03_个人项目归档/loop-engineering",
  "worktree_path": "E:/03_个人项目归档/loop-engineering/.worktrees/20260628-001",
  "branch": "loop/20260628-001-worktree-allocator",
  "base_ref": "HEAD",
  "created_at": "2026-06-28T00:00:00.000Z",
  "managed": true,
  "status": "active"
}
```

字段说明：

- `schema`：版本化契约，便于未来迁移。
- `mode`：`none`、`existing`、`created`、`adopted`。
- `owner`：创建者标识；cleanup 只能处理 `loop-engineering` 管理的 binding。
- `repo_root`：原始仓库根目录。
- `worktree_path`：本 run 的真实工作目录。
- `branch`：created 模式下创建的分支；none/existing/adopted 可为 `null`。
- `base_ref`：创建或绑定时的基准 ref。
- `managed`：是否由 allocator 创建并允许 cleanup。
- `status`：`active`、`kept`、`cleaned`、`cleanup_failed`。

`run-state.json` 增加两个字段：

```json
{
  "workdir": "E:/.../.worktrees/20260628-001",
  "worktree_binding_path": "E:/.../runs/20260628-001/worktree-binding.json"
}
```

`workdir` 是运行时快捷字段；`worktree_binding_path` 是审计和恢复入口。

## Run 目录位置

推荐一期采用：

```text
<worktree_path>/runs/<run_id>/
```

也就是创建 worktree 后，再在 worktree 内初始化 run 目录。

原因：

1. Claude Code hook 和 OpenCode plugin 通常以项目 cwd 为锚点运行。
2. 如果 run artifacts 留在原仓库，而 hook 在 worktree cwd 下执行，就需要额外传递 `LOOP_RUNS_ROOT` 或读取跨目录配置。
3. 把 `runs/` 放进 worktree 内，可以让 hook、dispatch、collect-outcome 使用同一个 cwd 模型。

如果未来需要集中 run registry，可以再增加：

```text
LOOP_RUNS_ROOT=<absolute path>
```

但这不作为一期默认设计。

## 创建流程

`worktree-mode=none`：

1. 不创建 binding 或写入 mode=`none` 的 binding。
2. `runDir = <project>/runs/<run_id>`。
3. `workdir = path.dirname(runDir)`，保持现有行为。

`worktree-mode=always`：

1. 解析 repo root：`git rev-parse --show-toplevel`。
2. 检查当前仓库不是 submodule 或嵌套 git 特殊场景；无法确认时失败。
3. 检查 `.worktrees/` 是否被 git ignore 覆盖；未忽略则失败并给出修复建议。
4. 检查目标路径不存在。
5. 生成 branch：`<branch-prefix><run_id>-<slug>`。
6. 执行 `git worktree add <worktree_path> -b <branch> <base_ref>`。
7. 在 `<worktree_path>/runs/<run_id>` 初始化 run 目录。
8. 写 `worktree-binding.json`。
9. 写 `run-state.json.workdir`。
10. 同步项目级 hook 配置到 worktree。

`worktree-mode=auto`：

1. 如果当前目录已经是 git linked worktree，绑定当前目录。
2. 否则按 always 创建。

`worktree-mode=adopt`：

1. 校验 `--worktree-path` 存在。
2. 校验该路径是同一 repo common dir 下的 worktree。
3. 在该路径下初始化 run 目录。
4. 写 mode=`adopted`、managed=`false` 的 binding。

## Hook 配置同步

Worktree allocator 必须保证 worktree 是一个可运行的 Loop Engineering 项目空间。

Claude Code：

- 如果原项目安装的是 CLI hook mode，则 worktree 内 `.claude/settings.json` 也要包含 `e2e-loop hook <hook-name>`。
- 如果原项目安装的是 local hook mode，则需要复制 `.claude/hooks/loop_engineering/*.mjs`。
- 推荐与 CLI hook 改造配套使用：新 worktree 默认写 CLI hook mode，减少相对路径复制失败。

OpenCode：

- OpenCode 仍通过 `.opencode/plugins/loop-engineering.js` 生效。
- allocator 只保证 worktree 内项目级 `.opencode` 配置存在；宿主适配继续留在 plugin 层。

同步策略：

1. allocator 不重新设计 hook 协议。
2. allocator 复用现有 install/adapter 逻辑，把必要项目配置写入 worktree。
3. 如果同步失败，run 初始化失败，而不是创建一个 hook 不可用的半成品 worktree。

## Coordinator 接入

新增 helper：

```text
packages/ssot-ts/src/worktree/binding.ts
packages/ssot-ts/src/worktree/allocator.ts
```

职责：

- `binding.ts`：parse/write/read `worktree-binding.json`。
- `allocator.ts`：检测 git worktree 状态、创建 worktree、adopt 已有路径、cleanup。

Coordinator 接入点：

- 构造阶段读取 binding，优先用 binding 的 `worktree_path` 做 capability probe。
- `dispatchReadyTasks()` 调用 `buildPacket(..., { workdir })`。
- bootstrap 降级重建 packet 时也传入同一个 `workdir`。
- collect-outcome 从 `dispatch.json.packet.workdir` 读取，不再重新猜测。

`buildPacket()` 的默认行为保留，确保没有 binding 的旧 run 仍能运行。

## 与 Multi-Service Worktree 的关系

现有 `service_map.ts` 解决的是“service name 到已有 worktree 路径”的映射，不负责创建 git worktree。

本设计解决的是“一个 run 的主工作目录如何创建和绑定”。

一期关系：

- 单服务 run：使用 run-level binding。
- 多服务 run：继续使用 service map 的已有路径校验。
- 不自动为每个 service 创建 worktree。

未来可以扩展为：

```text
run binding
  └── services
      ├── api -> worktree A
      └── web -> worktree B
```

但这属于二期。

## 安全与失败策略

原则：宁可失败，也不要静默污染用户工作区。

失败场景：

- 当前不是 git repo：`always/auto` 失败；`none` 可继续。
- `.worktrees/` 未被 ignore：失败并提示添加 `.worktrees/`。
- 目标路径已存在：失败，不自动复用。
- branch 已存在：失败，不自动 checkout。
- base dirty：默认失败；未来可加 `--allow-dirty-base`。
- 创建 worktree 成功但 run 初始化失败：标记 binding 为 `cleanup_failed`，提示人工处理。
- cleanup 时 worktree dirty：拒绝删除。
- managed=false：cleanup 拒绝删除。

Windows 注意点：

- git 命令通过参数数组调用，不拼接 shell 字符串。
- 删除 worktree 前先用 `git worktree list --porcelain` 校验路径归属。
- 删除目录只允许发生在 binding 指向的 managed worktree 内。

## 测试覆盖

新增测试建议：

1. `none` 模式不改变 run 目录和 `WorkerPacket.workdir` 默认行为。
2. `always` 模式创建 binding，`workdir` 指向 worktree。
3. `.worktrees/` 未 ignore 时创建失败。
4. branch/path 已存在时创建失败。
5. `adopt` 模式绑定已有 worktree，managed=false。
6. `Coordinator` capability probe 使用 binding workdir。
7. `dispatchReadyTasks()` 产出的 packet 使用 binding workdir。
8. bootstrap `collectTaskOutcome()` 重建 packet 时仍使用 binding workdir。
9. Claude Code CLI hook 配置在 worktree 内可用。
10. cleanup 拒绝删除 dirty 或 unmanaged worktree。

验收命令：

```text
bun test tests-ts
npm run build
npm run typecheck
```

如果只落一期最小实现，至少跑聚焦测试：

```text
bun test tests-ts/ssot/worktree_allocator.test.ts
bun test tests-ts/ssot/coordinator_dispatch_collect.test.ts
bun test tests-ts/install.test.ts
```

## 迁移策略

1. 默认 `--worktree-mode none`，不影响已有用户。
2. 先实现 binding schema 和 read/write，不接入创建逻辑。
3. 再实现 `always/adopt`。
4. 接入 coordinator 的 `workdir` 读取。
5. 最后接入 hook 配置同步和 cleanup。

每一步都保持旧 run 可读、旧 packet 可 collect。

## 验收标准

- 未启用 worktree mode 时，现有测试和行为不变。
- 启用 `--worktree-mode always` 后，run artifacts、hook cwd、worker packet、actual writes 全部指向同一个 worktree。
- allocator 创建的 worktree 有可审计 binding。
- allocator 不删除非 managed worktree。
- OpenCode 仍通过 plugin 生效，不新增用户可见宿主参数。
- Claude Code 推荐使用 CLI hook mode，避免 worktree 内 local `.mjs` 路径失效。
