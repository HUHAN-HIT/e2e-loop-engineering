---
"e2e-loop": minor
---

fix(cli): doctor 双态化——目标项目里不再误判源码仓库产物缺失。

doctor 原只有"实现仓库态"一条判据路径, 在装了 .claude 资产的目标项目里跑会把
源码仓库构建产物 (bin/e2e-loop / packages/cli/dist 等) 全判 fail (假阴性)。现按当前
目录性质分三态:

- impl-repo (含 core/manifest.json + packages/cli/): 保持原构建产物判据 (现有测试不破)。
- target-project (装了 .claude/skills/loop-engineering/SKILL.md): 改为核对 skill/agents/
  hooks 装齐, 且 hook 命令走 CLI 形式 (e2e-loop hook <name>, 规避 .mjs 路径依赖——.mjs
  是 build 产物不随 commit 进库, 新 checkout / git worktree 里会 MODULE_NOT_FOUND)。
- unknown (两者皆非): blocked, 提示先 install 或 cd 到正确目录。

report 新增 mode 字段。cli_reachable 用纯静态判定 (不 spawn), 规避 Windows .cmd shim
裸 spawn 的 ENOENT 假阴性, 以及从 settings 解析 hook 前缀再 shell 执行的注入面。
