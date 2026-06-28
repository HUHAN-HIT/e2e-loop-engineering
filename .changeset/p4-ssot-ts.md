---
"@e2e-loop/ssot": minor
---

P4: Python SSOT → TS 迁移 M1-M6。把 loop_engineering/ 的 schema / state_machine / scheduling / checklists (含 checks_eval 递归下降解析器) / amendment / multi_service / trust_mode 七个算法子包用 zod + TS 迁到 packages/ssot-ts, scheduling 复用 @e2e-loop/shared 的 matchPath/actual_writes。tests-ts/ssot/ 271 条等价测试 (用例同源 Python tests/) 守护行为对齐, 全套 432 pass, pytest 295 无回归。Python SSOT 仍为共存期权威 (P5 删除)。
