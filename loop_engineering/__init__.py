"""Loop Engineering — 协作式开发 harness (算法参考库).

== 弃用通知 (DEPRECATION) ==

本 Python 包已进入 **deprecated 共存期** (设计决策 D-2 / cross-host-design §9.5).
P4/P5 已把全部算法迁到 TypeScript SSOT (packages/ssot-ts, 发布为 npm @e2e-loop/ssot):
schema / state_machine / scheduling / checklists / amendment / multi_service /
trust_mode / runtime / dispatch 均已有等价 TS 实现.

- **新代码请用 @e2e-loop/ssot** (TS SSOT), 不要继续在本 Python 包上新增逻辑.
- 本包在共存期内仍是**等价测试的权威锚点** (行为权威): TS 实现的等价测试以本包
  对应模块的输出为对照基准, 守护两侧行为一致, 直到 1.0.0 删除本包.
- 删除时机: 全部子包等价测试通过且 TS SSOT 成为唯一权威后, 在下一个大版本 (1.0.0)
  移除 loop_engineering/ Python 包, 文档全切 `npm install -g e2e-loop`.

规范源: loop-engineering-collaborative-design.md (本仓库 outputs/ 目录下).
默认实现 collaborative 档 (design §5), MVP 范围 (design §7).

== 边界标注 (重要) ==

本 Python 包**不是** Claude Code / opencode 实际运行的协调器入口.
Claude Code 的主 agent 即协调器, 由 .claude/skills/loop-engineering/SKILL.md
指导; 子 agent 由 .claude/agents/*.md 定义; 主 agent 通过 Task 工具分发 worker.

本包的角色是**算法真理来源 (SSOT)**: 当 SKILL.md 或子 agent 提示词需要
某种判断原语 (例如路径是否相交、check 是否通过、AC 如何回滚扩展) 时,
以本包对应模块的实现与测试为参考.

== 子包分类 ==

算法 SSOT (协作式判断原语, 可被提示词引用):
- schema/        数据模型 (RunState / TaskPlan / Artifacts / Clarification / ServiceContracts)
- state_machine/ 阶段迁移合法性、人工锚点阶段矩阵 (§3.7, §4)
- scheduling/    路径相交、就绪前沿、watchdog、actual_writes 收集 (§3.2-§3.6, §0.2)
- checklists/    checks 文法评估、key-diffs 分级门、plan/task/wrap-up 自检清单 (§0.1, §8)
- amendment/     保守扩围: AC 索引与回滚扩展 (§3.6)
- multi_service/ 契约 diff、传播、服务地图 (§11)
- trust_mode/    trust-mode 切换门 (§5, §0.3)

未用运行时 (仅作设计参考, 不在 Claude Code 中被调用):
- runtime/       目录布局与单刻度循环 (§1, §3.7) — 主 agent 直接按 SKILL.md 执行, 不经此模块
- dispatch/      worker packet 构造与产物收集 (§0.4) — 由 Task 工具的实际调用替换
- cli.py         argparse 入口 — 仅用于本地 dry-run 与测试, 非 Claude Code 入口

== 测试 ==

tests/ 目录下 265+ 测试覆盖算法 SSOT 部分; runtime/dispatch/cli 仅做最小契约测试.
"""

__version__ = "0.1.0"
