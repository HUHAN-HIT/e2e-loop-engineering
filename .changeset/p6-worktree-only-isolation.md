---
"@e2e-loop/ssot": minor
"@e2e-loop/shared": minor
"@e2e-loop/cli": minor
---

P6 (Worktree-Only 隔离, spec 2026-06-29): Claude Code 宿主默认走"一 run 一专属一次性 worktree"形态。

- 改动① (阶段1): `syncProjectHookConfig` 不再盲抄主工程 `.claude/` —— worktree 内 settings 用 `keepOnlyLoopHooks` 过滤成只含 e2e-loop 4 hook, 不抄 `.opencode`; allocator 在 worktree 根写 `.loop-engineering/worktree.json` marker (owner/run_id/created_at, 走 atomicReplace)。新增 `@e2e-loop/shared` 的 `worktree_marker.ts` (marker 读 helper `readWorktreeMarker`/`isInLoopWorktree` + loop hook 判据 + settings 过滤纯函数) 与 ssot-ts 的 `worktree/marker.ts` (marker 写)。
- 改动② (阶段2): enforcement 主体落 CLI 层。`runInit` worktree 模式末尾打印进 worktree 引导 (cd <workdir>); `runDispatch`/`runRun` 加 worktree 硬 gate —— 只对 worktree 模式 (state.workdir 非空) 的 run 生效, 要求 cwd 的 marker.run_id 匹配该 run, 不满足则 stderr + 退出码 2, none 模式 (workdir 空) 一律放行 (零回归)。`probe_and_gate` 增 worktree 内一致性正向自检: cwd marker.run_id 与 active run 不一致时注入 `worktree_marker_warning`, 一致/无 marker 维持原行为, 异常仍退化放行 (守红线)。
- 改动③ (阶段2): "一 worktree 一 run" 机械校验 —— `runInit` 在 allocation 前若检测到 cwd 已是 loop worktree (有 marker) 则拒绝再 init (退出码 2, 信息含"一个 worktree")。

TDD 守护: 新增 `tests-ts/cli_worktree_gate.test.ts` (8 用例: init 拒绝/引导 + dispatch/run 的 none-放行/worktree-拒绝/worktree-放行) 与 `tests-ts/probe_and_gate.test.ts` 扩展 (marker 一致/不一致/无 marker 三态)。全套 bun 577 pass, tsc --noEmit 0 error, none 模式集成测试 (integration_dry_run / integration_dispatch_collect) 无回归。
