# Run 收口自动 commit / push / PR(finalize)能力设计

## 背景

Loop Engineering 的一次 run 推进到 `COMPLETE` 后,代码改动留在 worktree(隔离模式)或主仓库工作区(none/existing 模式),**后续的 `git commit` → `push` → 建 PR 完全在 harness 之外**,靠人或主 agent 手动完成。

当前收口链路三处节点全部只读:

- 收口自检 `checkWrapUp`([wrap_up_check.ts](../../../packages/ssot-ts/src/checklists/wrap_up_check.ts))只做 5 项只读检查(task 自检绿、key-diffs 齐备、scope 一致、硬 gate、集成测试绿),无任何 git 写。
- worktree binding([binding.ts](../../../packages/ssot-ts/src/worktree/binding.ts))`status` 只到 `active/kept/cleaned/cleanup_failed`,没有 commit/push/PR。
- 状态机 `WRAPPING_UP → COMPLETE` 即终态([transitions.ts](../../../packages/ssot-ts/src/state_machine/transitions.ts)),COMPLETE 无后继。

全库搜 `pull request / gh pr / createPR` 零匹配。本能力把"run 收口后的发布动作(commit/push/建 PR)"变成 harness 的一等可选能力,默认全自动,但策略由用户在 run 启动时选定。

## 当前事实(接入点)

- **worktree 已产出专用分支(隔离模式)**:`allocateCreated` 在 init 时 `git worktree add <path> -b loop/<run_id>-<slug> <baseRef>`([allocator.ts:172](../../../packages/ssot-ts/src/worktree/allocator.ts#L172)),binding 记 `branch` + `base_ref`。none/existing/adopted 模式 `branch = null`。
- **`base_ref` 默认是字面量 `"HEAD"`**(`DEFAULT_BASE_REF`),且"建 worktree 时 HEAD 指向哪个符号分支"未被记录。
- **worker 不 commit**:actual_writes 由 coordinator 侧 `git diff` 采集([actual_writes.ts:215](../../../packages/shared/src/actual_writes.ts#L215)),每个 task 一份 `tasks/<id>/actual-writes.json`。**没有"本 run 全部代码改动"的聚合清单**。
- **能力探测已有范式**:`probeCapabilities`([capabilities.ts](../../../packages/ssot-ts/src/scheduling/capabilities.ts))在 CREATED 探测 git/fs,异常吞掉返回保守 false。
- **worktree cleanup 拒绝 dirty**:`cleanupManagedWorktree` 在 `git status --porcelain` 非空时拒绝 remove([allocator.ts:266](../../../packages/ssot-ts/src/worktree/allocator.ts#L266))。
- run-state 有 `trust_mode` / `RunConfig` 策略位,但**无收尾策略字段**([run_state.ts](../../../packages/ssot-ts/src/schema/run_state.ts))。
- allocator/actual_writes 均已用可注入的 `GitRunner` / execFile seam,便于测试。

## 最终决策

采用 **方案1 · 混合落点**:SSOT 提供确定性纯函数判断原语,CLI 新子命令 `e2e-loop finalize` 编排有副作用的 git/gh,提示词层在收口触发。双宿主(CC + OC)调同一 CLI,行为天然一致。

`finalize` 是 **`COMPLETE` 之后的独立发布步骤**,不改状态机、不回退 phase、不新增 phase/人锚点。

## 关键决策与依据

| 维度 | 决策 | 依据 |
| --- | --- | --- |
| 档位 | `off` / `commit` / `commit_push` / `full_pr`,默认 `full_pr` | 用户要默认全自动,但作为 run 级可选策略 |
| 默认 PR 形态 | `full_pr` 默认建 **draft PR** | 不架空"人看 key-diffs"红线(coordinator.md:252):代码已推、PR 可预览,但 draft 明确"待人复核后转正式/合并" |
| 分支策略 | head 永远是 `loop/<run_id>-<slug>`;created 复用 allocator 已建分支,none/existing 收口时新建;**永不直接 push 当前分支** | 当前分支可能是 master,直推有污染主干风险 |
| commit 清单 | 各 task `actual-writes.json` 的**并集**,**不用 `git add -A`** | git add -A 会把用户工作区无关 WIP 卷进 PR(P0) |
| PR/MR 后端 | 自适应 `pr_backend`:探到 gh+GitHub → 自动建 draft PR;否则**通用降级**(push + 抓 push stderr 返回的建 MR/PR 链接) | commit/push 平台无关,只有"建 PR/MR"这步因平台而异;内部仓库(GitLab/Gitea/…)非 GitHub |
| 退化 | 逐级退化 commit → push →(建 PR 或给链接),停在上一步成功处并如实报告 | 红线"诚实高于合规外观" |
| binding schema | **不改**;commit_sha/pr_url 记 `wrap-up/finalize-result.json` | 最小侵入,binding 保持纯审计(v1 严格 zod) |

## 命令契约

```text
# init 时选定收尾策略(缺省 full_pr)
e2e-loop init <requirement> [--finalize <off|commit|commit_push|full_pr>] [--pr-draft|--no-pr-draft]

# 收口后执行发布(由提示词层在进入 COMPLETE 后调用)
e2e-loop finalize <run_id> [--dry-run] [--force]
```

- `--finalize` 缺省 `full_pr`;写入 run-state.finalize_policy。
- `--pr-draft` 缺省 true(draft PR,仅 `pr_backend=github` 适用;内部仓库走 `link_only` 时此项无效)。`--no-pr-draft` 显式建正式 PR。
- `e2e-loop finalize --dry-run`:只跑 probe + plan,打印"将提交哪些文件 / head→base / 是否 push / 建 draft PR",不执行副作用。供主 agent 在真正 finalize 前回显给人。
- `e2e-loop finalize --force`:none/existing 模式下,即使工作区存在不属于本 run actual_writes 并集的未提交改动也放行(仅提交并集内文件,其余留在工作区)。缺省不带 `--force` 时遇此情况拒绝并提示。

## finalize_policy schema(run-state 顶层新增)

```ts
export const FinalizePolicySchema = z.enum(["off", "commit", "commit_push", "full_pr"]);
// RunStateSchema 顶层新增,默认 full_pr,nullish 兼容旧 run:
//   finalize_policy: FinalizePolicySchema.nullish().default("full_pr"),
//   finalize_pr_draft: z.boolean().nullish().default(true),
```

旧 run-state.json 无此字段 → 解析后取默认 `full_pr` / draft。

## SSOT 新子包 `packages/ssot-ts/src/finalize/`

全部纯函数 + zod,可单测,不在会话中被 import,仅 CLI 引用。

- `policy.ts` — `FinalizePolicySchema` + `requiredChannels(policy)`(档位 → 需要 push/pr 哪些通道)。
- `channel.ts` — `probeFinalizeChannel(workdir, seams?)` → `FinalizeChannel{ has_remote, pr_backend, gh_ready }`,`pr_backend ∈ {"github","none"}`(MVP;`gitlab`/`gitea` 后续可加)。逐级探测:`git remote get-url origin`(有无 remote)、URL host 是否 GitHub(github.com 或 `GH_HOST` 指定的 Enterprise 域名)、`gh auth status`(已安装+已认证)。非 GitHub 或 gh 未就绪 → `pr_backend="none"`(走通用降级)。任何异常吞掉返回保守值。seam 可注入。
- `push_url.ts` — `extractCreateUrl(pushStderr)`:从 `git push` 的 stderr 提取平台返回的建 MR/PR 链接(GitLab `merge_requests/new?...`、GitHub `pull/new/...`、Gitea 等);抓不到返回 `null`,由调用方按 remote URL 拼 compare 链接兜底。纯函数,正则提取。
- `plan.ts` — `planFinalize(input)` → `FinalizePlan{ head_branch, base_ref, need_create_branch, do_commit, do_push, pr_action, pr_backend, pr_draft, downgraded_from, downgrade_reason }`,`pr_action ∈ {"none","auto_create","link_only"}`:`full_pr`+`pr_backend=github` → `auto_create`(建 draft PR);`full_pr`+`pr_backend=none` → `link_only`(push + 给链接,**正常终点非失败**);`commit_push` → `link_only`。**统一 loop/ 分支 + 自适应后端 + 逐级退化的全部决策都在此纯函数内**。输入:binding、当前分支、`finalize_policy`、`pr_draft`、channel、commit 清单是否非空、commit 并集是否 authoritative。
- `message.ts` — `buildCommitMessage(keyDiffsMd, runMeta)` / `buildPrBody(keyDiffsMd, runMeta)`。PR 正文头部固定插入声明:**"以下改动清单来自 worker 自报 key-diffs(软约束),draft 状态,待人复核后转正式/合并"**(回应自报数据对外的风险)。
- `result.ts` — `FinalizeResultSchema` / `buildFinalizeResult(...)`。

## commit 范围(P0-1 修正)

commit 清单 = run 内各 task `tasks/<id>/actual-writes.json` 的 `paths` 并集,去重排序。

- 用 `git add -- <path...>`(显式 pathspec)而非 `git add -A`,精确只暂存本 run 改动。
- 天然排除:run 启动前就存在的无关脏改动、`runs/` 工件目录(coordinator 单写,不在任何 task 的 actual_writes 内)。
- 并集为空(无任何代码改动)→ skip commit,finalize-result 记 `no_changes`,不建空 PR。
- **none/existing 模式前置守卫**:finalize 前若工作区存在不属于本 run actual_writes 并集的未提交改动,默认 **拒绝并提示**(避免误把用户 WIP 切进 loop/ 分支);可由 `--force` 显式放行(仅提交并集内文件,其余留在工作区)。
- **actual_writes 不可信守卫**:若并集来源是 worker 自报(`is_authoritative=false`,capabilities 退化),commit 范围本身不可信 → **禁止自动 push/PR**,降级为只本地 commit + 提示人(`achieved=commit`,`downgrade_reason` 记原因)。堵掉"最坏情况"里唯一会对外造成失真损害的路径。

## 分支与 base 解析(P0-2 修正 + 分支策略)

- head 分支恒为 `loop/<run_id>-<slug>`(`slug` 复用 allocator 既有 `slugify(requirementSlug)`:created 模式直接取 binding.branch,none 模式从 run 元数据取 requirement slug)。
  - created/always 模式:复用 binding.branch(allocator 已建),`need_create_branch = false`。
  - none/existing/adopt 模式:`need_create_branch = true`,finalize 时 `git switch -c loop/<run_id>-<slug>`(只携带并集内文件,见上)。
- **base 必须是符号分支名,不能是 `"HEAD"`**:
  - allocator 在 init 建 worktree 前,把 base 解析为符号分支名(`git rev-parse --abbrev-ref <baseRef>`,`HEAD` → 具体如 `master`),写入既有 binding.base_ref 字段(只改写入值,**不改 binding schema**)。
  - none 模式:base = finalize 切分支前的当前符号分支名。
  - finalize 端兜底:读到的 base_ref 仍为 `HEAD` 或解析不出符号名(旧 binding / detached HEAD)→ 重新解析,失败则退化为 `commit_push`(不建 PR),如实报告。

## 凭证与非交互(P1-3)

- 所有 git/gh 子进程强制 `GIT_TERMINAL_PROMPT=0` + 非交互环境,杜绝缺凭证时弹密码挂起。
- `probeFinalizeChannel` 把 `gh auth status` 纳入 `gh_ready`;push 凭证不可单独 probe,故 push 失败按"退化为已 commit"处理并报告,绝不挂起。
- 子进程统一超时(沿用 allocator/actual_writes 的 10–30s 量级)。

## 时序:finalize 与 cleanup 硬序(P1-4)

- 提示词层顺序固定:`WRAPPING_UP 自检全绿 → advance COMPLETE → (policy != off) e2e-loop finalize → 回报结果 → (可选) worktree cleanup`。
- **finalize 成功(或显式跳过)是 cleanup 的前置**:CLI `finalize` 成功后在 finalize-result 标记 `finalized: true`;cleanup 路径检查该标记,未 finalize 不得 remove worktree(避免代码随 worktree 被删)。
- finalize 在 worktree 内 commit 后工作区变 clean,既有 `cleanupManagedWorktree` 的 dirty 守卫自然放行。

## 幂等(P1-5)

`finalize` 可安全重跑,分三段各自幂等:

- 分支:`need_create_branch` 时若目标分支已存在 → 直接 `git switch`(不 `-c`),不报错。
- commit:并集已全部在 head 分支提交(工作区对并集 clean)→ skip,复用既有 commit_sha。
- push:已 push 且无新 commit → skip。
- PR(`pr_backend=github`):finalize-result 已有 `pr_url`,或 `gh pr view <head>` 已存在 → skip 建 PR(可选更新正文)。`link_only` 时 `create_url` 重算即可,无副作用,天然幂等。

## finalize-result.json schema(`wrap-up/finalize-result.json`)

```ts
export const FinalizeResultSchema = z.object({
  schema: z.literal("loop-engineering.finalize-result.v1"),
  policy: FinalizePolicySchema,
  achieved: z.enum(["off", "no_changes", "commit", "commit_push", "full_pr"]),
  head_branch: z.string().nullable(),
  base_ref: z.string().nullable(),
  commit_sha: z.string().nullable(),
  pushed: z.boolean(),
  pr_url: z.string().nullable(),
  pr_draft: z.boolean(),
  pr_backend: z.enum(["github", "none"]),
  create_url: z.string().nullable(),    // 建 MR/PR 链接:link_only 或 auto_create 失败时,优先取 push stderr,兜底按 remote URL 拼
  finalized: z.boolean(),               // cleanup 前置标记
  downgrade_reason: z.string().nullable(),
  errors: z.array(z.string()),
});
```

## 退化矩阵(逐级 + 如实报告)

| 情形 | achieved | pr_backend | 给人的信息 |
| --- | --- | --- | --- |
| `policy=off` | `off` | — | 不做发布 |
| commit 清单为空 | `no_changes` | — | 无代码改动,未建分支/PR |
| 无 remote / push 失败 | `commit` | — | 已本地 commit 到 `<head>`,请手动 push |
| **非 GitHub(内部仓库)/ gh 未就绪** | `commit_push` | `none` | **正常终点**:已推 `<head>`,`create_url` = push stderr 返回的建 MR 链接(抓不到则按 remote URL 拼 compare;再拼不出则只报"已推,请手动建 MR") |
| GitHub + gh 就绪 | `full_pr` | `github` | 返回 draft PR URL |

关键区分:`commit_push` + `pr_backend=none` 在 `full_pr` 策略下**不是退化告警,是内部仓库的预期结果**——`downgrade_reason` 留空,只填 `create_url`。真正的退化(无 remote/push 失败)才写 `downgrade_reason` + `errors`。**绝不在 errors 为非空时谎报 `full_pr`**。

## 与状态机 / 失败处理

- finalize 不动 `transitions.ts`、不新增 phase、不新增 `human_pending`。COMPLETE = 开发完成;发布失败不把 run 拖回未完成。
- 失败仅记 `finalize-result.errors` + 提示人接手。
- `full_pr` 默认全自动建 draft PR,不设"建 PR 前人点头";若日后需要,可复用既有 `wrap_up_signoff` 锚点(正交,本期不做)。

## 提示词触发(双宿主)

- `core/coordinator.md`:
  - CREATED 开场段:确认本 run 收尾策略(默认推荐 `full_pr` + draft),写入 run-state。
  - 收口段:自检全绿 → COMPLETE → `policy != off` 时跑 `e2e-loop finalize <run_id>`(高复杂度/risk 可先 `--dry-run` 回显给人),把结果摘要(draft PR URL 或"还差什么")回报。
- `docs/loop-engineering-master-prompt.md` + OpenCode SKILL(install 落地)同步同一句。两宿主调同一 CLI。

## 测试策略

- SSOT 纯函数单测:`planFinalize` 全分支矩阵(created/none/existing/adopt × 4 档 × channel 各级退化 × 空并集 × detached HEAD);`probeFinalizeChannel` seam;`buildCommitMessage/buildPrBody`(含自报声明头);`requiredChannels`。
- CLI 集成:注入 fake `GitRunner` + fake gh runner,断言命令序列、finalize-result.json、退化路径(无 remote / 无 gh)、幂等重跑、none 模式 dirty 守卫与 `--force`、`--dry-run` 不产生副作用。
- 跨宿主契约:install 后两宿主提示词均含 finalize 触发句(对齐既有 publish_contract 测试风格)。
- `changlog.md` 增条目。

## 目标

1. run 启动时可选收尾策略,默认全自动建 draft PR。
2. 收口后确定性执行 commit(actual_writes 并集)→ push(loop/ 分支)→ 建 draft PR(GitHub)或输出建 MR/PR 链接(内部仓库通用降级)。
3. 任一前置不满足逐级退化并如实报告,绝不谎报、绝不挂起、绝不污染主干或用户 WIP。
4. 双宿主行为一致;判断逻辑纯函数可测。
5. finalize 与 worktree cleanup 有明确硬序。

## 非目标

- 不自动 merge / 不自动解决 git 冲突(沿用 worktree-allocator spec 既定边界)。
- MVP 不做 GitLab/Gitea/Bitbucket 的**平台原生自动建 MR**;非 GitHub 一律走通用降级(push + 抓/拼建 MR 链接,人点一下建)。后续可在 `pr_backend` 上增量加 `gitlab`(glab/API)等后端,**不改 commit/push 主体**。
- 不做"同 run 多次 finalize 复用同一 PR 并更新正文"的高级形态(MVP 只保证 PR 幂等不重复创建)。
- 不改 `cleanupManagedWorktree` 内部逻辑,只增加 finalize 前置判定。
- 不改 worktree-binding.json schema。

## 风险与残留

- **none 模式 WIP 交叠**:若某文件既被本 run 改、又被用户 WIP 改,actual_writes 并集与守卫只能拒绝/提示,无法干净切分。缓解:推荐隔离 worktree 模式;none 模式 dirty 时默认拒绝。
- **PR 描述源自软约束**:key-diffs 是 worker 自报。缓解:draft + 正文显式声明 + 人复核后才转正式。
- **gh 版本差异**:`gh pr create --draft` 行为依赖 gh 版本;probe 仅验证 auth,版本异常归入 push/pr 失败的退化与 errors。
- **建 MR 链接靠 push stderr**:个别平台/配置不在 push 时输出建 MR 链接,则退化为按 remote URL 拼 compare 链接;遇未知 host 拼不出 → 只报"已推 `<head>`,请手动建 MR"。`extractCreateUrl` 用正则匹配已知平台的 stderr 格式,新平台格式变动需补正则。
