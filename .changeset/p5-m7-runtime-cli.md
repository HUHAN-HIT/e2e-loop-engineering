---
"@e2e-loop/ssot": minor
"@e2e-loop/cli": minor
---

P5 (M7 + 收尾): runtime (Coordinator/tick/directory) + dispatch (packet/collect/worker_runner) 迁到 packages/ssot-ts; TS CLI 加 9 个算法 dry-run 子命令 (init/status/plan/run/wrap-up/signoff-plan/signoff-wrap-up/abort/amend) 接 TS runtime, 与 Python cli.py 等价。Python 包标记 deprecated (共存期保留作等价测试锚点); 文档切 npm-first (新建根 README + CLAUDE.md 命令族)。新增 cross_host_consistency e2e 证明 CC/OC 决策一致 (CC deny ⟺ OC throw) 与共享 SKILL.md 字节一致。全套 bun 468 pass, pytest 295 无回归。物理删除 Python 包 + 1.0.0 待后续确认。
