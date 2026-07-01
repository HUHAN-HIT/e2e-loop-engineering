---
"@e2e-loop/shared": minor
"@e2e-loop/ssot": patch
"@e2e-loop/adapter-claude-code": patch
"@e2e-loop/adapter-opencode": patch
"e2e-loop": minor
---

fix: task-plan.yaml 含未引用冒号致全 run 卡死 —— 三层加固 + doctor --run 预检

## 根因
plan-agent (LLM) 手写的 `planning/task-plan.yaml` 里, 中文 `scenario` / `title` 值常含
`: `(冒号+空格) 且未加引号 —— YAML 会把它误判为嵌套 mapping, js-yaml 抛 `YAMLException`。
`ssot-ts` 的 `readTaskPlan` 让该异常直接冒泡, Coordinator 构造函数崩, 于是每个重建
Coordinator 的 CLI 子命令 (dispatch / collect-outcome / status / run) 碰到该 run 就崩,
报错是不可读的 js-yaml 堆栈; hook 侧则把损坏静默降级成"计划缺失", 诊断毫无指向。

## 三层加固
1. **预防 (plan-agent)**: `test-design-standard.md` 新增 §4.5 "YAML 书写红线" (scenario/title
   含冒号等元字符必须加双引号, 附正反例), plan-agent.md 加硬性一行指针。
2. **诊断 helper (共享)**: `@e2e-loop/shared` 新增 `yaml_diag` (`describeYamlError` /
   `parseYamlSafe`)——把 YAMLException 转成带【文件/行号/列号 + 冒号修复提示】的可执行诊断,
   三方复用。
3. **止崩 + 自愈**:
   - `ssot-ts` `readTaskPlan` / `readTaskDetail` 改走 `parseYamlSafe`, 抛可读诊断而非裸堆栈。
   - `shared` 新增 `readTaskPlanDiag` (区分 missing / parse_error / invalid / ok);
     `post_task_collect` 与 `guard_anchors` 的 deny/Stop 消息带上行号+冒号提示, 主 agent
     据此可精确指挥 plan-agent 加引号 (闭环自愈), 不再只报"解析失败"。

## 新增预检
`e2e-loop doctor --run <run_id>` 新增 run 产物预检模式: 在跑任何真实子命令前校验该 run 的
`task-plan.yaml` 能否解析 (复用 `describeYamlError`, 输出行号+冒号提示), 并软检查
run-state.json / design.md。把"运行时崩溃"提前成"可读 preflight"。

新增/调整测试: `yaml_diag.test.ts`、`task_plan_diag.test.ts`、`cli_doctor.test.ts` (+4 用例);
全量 644 测试通过。
