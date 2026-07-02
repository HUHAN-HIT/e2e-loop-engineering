# Task Plan Detail Split 设计方案

## 目标

当需求比较复杂时，`planning/task-plan.yaml` 可能会变得过长，导致 implementation worker 很难可靠地完整阅读。本设计保留 `task-plan.yaml` 作为紧凑的机器契约，同时将较长的 per-task 业务逻辑指导拆分到 `planning/task-details/<task-id>.yaml` 文件中，并由 coordinator 负责校验和注入。

该方案的目标是在不削弱现有控制面的前提下提升 worker 的上下文质量：

- 继续让调度、路径守卫、状态恢复和收口检查锚定在一个权威 task graph 上；
- 每个 worker 只接收自己 task 对应的 detail 文件；
- 将 detail 读取变成 dispatch 阶段的输入契约，而不是依赖 agent 自觉选择；
- 避免对现有单文件 task plan 做一次性破坏式迁移。

## 当前约束

当前实现强依赖单个 canonical plan 文件：

- `Coordinator` 从 `planning/task-plan.yaml` 恢复并持久化 plan 状态。
- `writeTaskPlan` 和 `readTaskPlan` 面向单个 YAML 文件工作。
- guard hooks 通过 `planning/task-plan.yaml` 的 mtime 缓存计划内容，用于执行 `allowed_write_paths`。
- `WorkerPacket.context_paths` 当前包含 `planning/design.md` 和 `planning/task-plan.yaml`。
- `TaskPlanSchema` 当前存储 task 身份、依赖、写路径、风险、契约、状态、attempt 和 planned tests，但没有用于承载长篇实现指导的结构化字段。

因此，如果把整个计划拆成多个同等权威文件，改动半径会很大。v1 应该优先拆分两类信息：

- 机器必需的紧凑 SSOT 字段；
- 人和 worker 需要阅读的长篇 advisory 字段。

## 非目标

- 不替换 `planning/task-plan.yaml` 作为 task ID、依赖 DAG、状态、attempt、`allowed_write_paths`、`risk`、`acceptance_refs` 或 planned tests 的来源。
- 不让 `task-graph.json` 成为权威来源。如果后续实现，它仍然只是带 source hash 的派生投影。
- 不把业务实现步骤塞进 `tests.checks`；checks 继续只表达机械断言。
- 不依赖 implementation worker 自愿追踪 `detail_ref` 链接。
- 不要求所有现有 task plan 立即添加 detail 文件。

## 建议文件布局

```text
runs/<id>/planning/
  design.md
  task-plan.yaml
  task-details/
    T01.yaml
    T02.yaml
    T03.yaml
  service-contracts.yaml
  plan-check-failures.json
```

`task-plan.yaml` 保持紧凑：

```yaml
schema: loop-engineering.task-plan.v2
complexity: complex
tasks:
  - id: T01
    title: 登录验证码接入
    detail_ref: planning/task-details/T01.yaml
    allowed_write_paths:
      - src/auth/login/**
      - tests/auth/login/**
    depends_on: []
    acceptance_refs: [AC-001, AC-002]
    exclusive: false
    risk: normal
    tests:
      - id: T01-CASE-001
        scenario: 验证码正确时进入密码校验
        checks: ["passed == true"]
```

`task-details/T01.yaml` 存储较长的 worker 指导：

```yaml
schema: loop-engineering.task-detail.v1
task_id: T01
summary: 登录流程接入验证码校验，但不改变密码校验和 session 签发语义。
business_logic_steps:
  - 读取现有登录入口，确认请求体解析、验证码校验、密码校验的先后顺序。
  - 在密码校验前插入验证码 token 校验，失败时返回既有错误响应结构。
  - 复用现有 auth error code，不新增跨层异常格式。
  - 保持验证码通过后的原密码校验流程和 session 签发流程不变。
files_to_inspect:
  - src/auth/login/**
  - src/auth/captcha/**
implementation_notes:
  - 如果现有登录入口同时承担 request parsing 和 domain validation，优先做小函数抽取。
  - 不修改 token 存储 schema；需要 schema 变化时返回 plan amendment。
acceptance_context:
  - ref: AC-001
    intent: 验证码正确时，登录流程继续进入原有密码校验。
    observable_behavior: 验证码通过后，原密码错误、密码正确、session 签发路径保持原语义。
    implementation_implications:
      - 验证码校验必须发生在密码校验前。
      - 验证码通过后应复用原登录流程，不新增并行登录分支。
verification_map:
  - acceptance_ref: AC-001
    planned_cases: [T01-CASE-001]
    notes: planned case 覆盖验证码通过后的主路径；缺失和错误验证码可在同 task 增加负向 case。
review_focus:
  - 检查验证码失败是否短路登录流程。
  - 检查验证码通过后原密码校验行为是否保持不变。
  - 检查是否越权修改 session 签发逻辑。
test_focus:
  - 覆盖验证码通过、验证码失败、验证码缺失三个路径。
  - 确认验证码通过后原密码错误路径仍返回原错误码。
```

## 契约模型

### `Task.detail_ref`

在 `TaskSchema` 中新增一个可选字段：

```ts
detail_ref: z.string().nullish().default(null)
```

规则：

- 路径相对于 run root，例如 `planning/task-details/T01.yaml`。
- 路径不能是绝对路径。
- 路径 normalize 后必须位于 `planning/task-details/` 之下。
- 对 `complexity=complex`，建议每个非平凡 task 都提供 detail 文件。
- 对 `risk=high` 或 `exclusive=true` 的 task，在迁移期结束后应要求 detail 文件。

### `TaskDetailSchema`

新增一个 schema 模块：

```ts
export const TaskDetailSchema = z.object({
  schema: z.string().default("loop-engineering.task-detail.v1"),
  task_id: z.string(),
  summary: z.string().default(""),
  business_logic_steps: z.array(z.string()).default([]),
  files_to_inspect: z.array(z.string()).default([]),
  implementation_notes: z.array(z.string()).default([]),
  acceptance_context: z.array(z.object({
    ref: z.string(),
    intent: z.string().default(""),
    observable_behavior: z.string().default(""),
    implementation_implications: z.array(z.string()).default([]),
  })).default([]),
  verification_map: z.array(z.object({
    acceptance_ref: z.string(),
    planned_cases: z.array(z.string()).default([]),
    notes: z.string().default(""),
  })).default([]),
  review_focus: z.array(z.string()).default([]),
  test_focus: z.array(z.string()).default([]),
});
```

校验不变量：

- `task_detail.task_id === task.id`。
- 当 detail 文件为必需时，`business_logic_steps` 不能为空。
- `acceptance_context[].ref` 必须属于当前 task 的 `acceptance_refs`。
- `verification_map[].acceptance_ref` 必须属于当前 task 的 `acceptance_refs`。
- `verification_map[].planned_cases[]` 必须属于当前 task 的 `tests[].id`。
- `acceptance_context`、`verification_map` 和 `review_focus` 不能定义新的验收标准；它们只能解释和映射 `task-plan.yaml` 中已有的 AC 与 planned cases。
- `files_to_inspect` 不能扩展 worker 权限；它只是阅读指导。
- `allowed_write_paths` 继续只存在于 `task-plan.yaml`。
- `tests` 继续只存在于 `task-plan.yaml`。

## Dispatch 行为

coordinator 必须让 detail 文件成为 worker 正常流程中不可绕过的输入。

当前 packet：

```ts
context_paths: [designMd, taskPlanYaml]
```

建议 packet：

```ts
context_paths: [
  taskDetailYaml,
  designMd,
  taskPlanYaml,
]
task_detail_path: taskDetailYaml
task_detail_required: boolean
```

如果存在 `detail_ref`：

1. 相对于 `runDir` 解析路径。
2. 校验路径位于 `planning/task-details/` 之下。
3. 读取并解析 `TaskDetailSchema`。
4. 校验 `task_id`。
5. 将该路径添加到 `context_paths` 的最前面。
6. 在 `WorkerPacket` 中包含 `task_detail_path`。

如果 `detail_ref` 是必需的但无效，coordinator 不得派发该 task。run 应停留在 planning / plan-check failure 状态，并给出确定性的诊断信息。

这样可以防止“agent 绕过 detail 文件”的失败模式：worker 不需要自己发现额外文件，而是把该文件作为最小必读上下文的一部分直接接收。

## Plan Check 行为

扩展 `checkPlan`，增加一个新的可选检查组。该检查组应保持客观可判定，不评价 prose 质量。

检查项：

1. `task_detail_ref_path_safe`
   - 每个非 null 的 `detail_ref` 都是相对路径，并且位于 `planning/task-details/` 下。
2. `task_detail_exists`
   - 每个必需的 detail 文件都存在。
3. `task_detail_task_id_matches`
   - 解析后的 detail 文件具有匹配的 `task_id`。
4. `task_detail_steps_present`
   - 如果 detail 是必需的，则 `business_logic_steps.length > 0`。
5. `task_detail_acceptance_refs_match`
   - `acceptance_context[].ref` 和 `verification_map[].acceptance_ref` 都必须属于当前 task 的 `acceptance_refs`。
6. `task_detail_planned_cases_match`
   - `verification_map[].planned_cases[]` 都必须属于当前 task 的 `tests[].id`。

要求策略：

```text
simple:
  detail_ref 可选

medium:
  detail_ref 可选；当 task 覆盖多个 AC 时建议提供

complex:
  risk=high 或 exclusive=true 时 detail_ref 必需
  其他 task 建议提供 detail_ref
```

首版实现只应强制客观的 required case。推荐项可以作为 navigation output 或 plan review summary 中的 warning 输出。

## Worker Prompt 变更

更新 implementation-worker 指导：

- 当 `task_detail_path` 存在时，它是第一个必读上下文文件。
- worker 应先读取 `task_detail_path`，再读取较宽泛的 `design.md`。
- `files_to_inspect` 只是阅读指导，不授予写权限。
- `acceptance_context` 用于理解 AC 的业务意图和可观察行为，不是新的验收标准。
- `verification_map` 用于把 AC 映射到 planned cases，帮助 worker 落测试、帮助 reviewer 快速定位验证覆盖。
- `review_focus` 用于提示 reviewer 重点查看的行为边界和风险点。
- 如果 detail steps、`acceptance_context`、`verification_map` 与 planned tests、`allowed_write_paths` 或 AC 冲突，worker 必须返回 plan amendment，而不是自行静默选择其中一方。

不应要求 worker 证明自己读过该文件。控制面上的改进在于：该文件足够短、位于 `context_paths` 第一位，并且专门面向当前 task。

## 为什么不拆分全部内容

完整的多文件 task plan 会把机器关键字段散落到多个文件中：

- dependency edges；
- task statuses；
- attempts；
- write paths；
- planned tests；
- contract provider / consumer links。

这会带来风险：

- 多文件 partial write；
- hook 缓存数据变旧；
- task 状态恢复不一致；
- path guard 读取成本增加；
- plan hash / signoff 语义更难定义；
- amendment rollback 复杂度上升。

将机器关键字段保留在一个紧凑文件中，可以保持当前 coordinator 和 hook 行为稳定。只拆分 detail 文件，则能以更小的 blast radius 获得上下文尺寸收益。

## 迁移计划

### Phase 1: 增量 Schema 支持

文件：

- 修改 `packages/ssot-ts/src/schema/task_plan.ts`
- 修改 `packages/shared/src/task_plan.ts`
- 修改 `packages/ssot-ts/src/runtime/yaml_io.ts`
- 新增 `packages/ssot-ts/src/schema/task_detail.ts`
- 新增 `readTaskDetail` 运行时 helper

行为：

- 新增可选 `detail_ref`。
- 新增 `TaskDetailSchema`。
- 保持没有 detail 文件的现有 task plan 继续可用。
- 确保 dump/read roundtrip 保留 `detail_ref`。

测试：

- 带 `detail_ref` 和不带 `detail_ref` 的 schema roundtrip；
- 无效 detail schema 失败；
- `detail_ref` 默认值为 null；
- `acceptance_context`、`verification_map` 和 `review_focus` roundtrip；
- detail 中引用不存在的 AC 或 planned case 时失败。

### Phase 2: Dispatch 注入

文件：

- 修改 `packages/ssot-ts/src/dispatch/packet.ts`
- 修改 `packages/ssot-ts/src/runtime/coordinator.ts` 中的 coordinator dispatch 路径
- 更新 `tests-ts/ssot/dispatch.test.ts`
- 更新 coordinator dispatch 测试

行为：

- 新增 `task_detail_path?: string | null`。
- 新增 `task_detail_required: boolean`。
- 如果存在有效 `detail_ref`，将 detail 文件 prepend 到 `context_paths`。
- 如果必需 detail 无效，返回确定性 plan-check failure，而不是派发 worker。

测试：

- 带 detail 的 task 得到 packet context paths `[detail, design, task-plan]`；
- 不带 detail 的 task 保持旧行为；
- task detail ID 不匹配时，在 detail 必需场景下阻止 dispatch。

### Phase 3: Plan Checks

文件：

- 修改 `packages/ssot-ts/src/checklists/plan_check.ts`
- 在 `tests-ts/ssot/plan_check.test.ts` 中新增测试
- 如有需要，更新 navigation map 诊断

行为：

- 新增客观 detail 检查。
- 首版只对 high-risk / exclusive complex task 强制 detail。
- 输出清晰诊断，包含 task ID 和无效路径。

测试：

- high-risk complex task 缺 detail 时失败；
- normal complex task 缺 detail 时通过或 warning，取决于所选 warning surface；
- 不安全的绝对 detail path 失败；
- 位于 `planning/task-details/` 外的 detail path 失败。

### Phase 4: Plan Agent 与 Standards

文件：

- 修改 `core/subagents/plan-agent.md`
- 修改 `core/standards/plan-standard.md`
- 修改 `core/subagents/implementation-worker.md`
- 可选更新 `docs/loop-engineering-prompts.md`

行为：

- plan agent 写紧凑的 `task-plan.yaml`。
- 对复杂 task，plan agent 写 per-task detail 文件。
- implementation worker 将 `task_detail_path` 视为第一个必读 context path。

验收：

- prompt 示例展示紧凑 plan 和 detail file；
- 不在示例中把业务步骤放入 `checks`；
- 示例明确区分阅读指导和写权限；
- 示例明确 `acceptance_context` / `verification_map` / `review_focus` 是验收解释与审查指导，不是第二套 AC。

### Phase 5: 可选 Packet 物化

如果实践中 worker 仍然跳过 context files，则新增一个物化 packet 文件：

```text
runs/<id>/dispatch/T01.packet.yaml
```

该文件可以 inline：

- 当前 task 核心字段；
- planned test cases；
- 解析后的 task detail 字段；
- dependency artifact paths；
- allowed write paths。

此时 worker 接收一个单独的紧凑 packet artifact。它比 context-path 注入更强，但作为第二步更合适，因为它会新增一个派生 artifact，并引入 hash / staleness 相关问题。

## 兼容性

向后兼容：

- 没有 `detail_ref` 的现有 task plan 仍然有效。
- 现有 hooks 可以继续从 `task-plan.yaml` 读取 `allowed_write_paths`。
- 现有 `task-plan.yaml` 仍然是 `key_artifacts` 中展示的文件。

向前兼容：

- `task-graph.json` 后续可以从紧凑 `task-plan.yaml` 投影生成。
- 如果 signoff 需要更强的不变性，后续可以将 `task-details/*.yaml` 纳入 plan signoff hash。
- Packet 物化后续可以移除 worker 读取完整 `task-plan.yaml` 的需要。

## 失败模式与缓解措施

### Worker 忽略 detail 文件

缓解：

- coordinator 将 detail path 注入 `context_paths`；
- detail path 出现在第一位；
- worker prompt 声明它是第一个必读 context；
- 可选 Phase 5 可以将 detail inline 到物化 packet 中。

### Detail 与 task-plan 矛盾

缓解：

- 对机器字段，task-plan 胜出；
- 如果矛盾影响实现，worker 返回 plan amendment；
- plan check 只验证 detail 的结构有效性，不做语义一致性裁决。

### Detail 文件过长

缓解：

- plan standard 应将 `business_logic_steps` 限制在约 3-9 条；
- detail 文件只包含当前 task 指导，而不是全 run 设计；
- 跨 task 设计继续保留在 `design.md`。

### Path guard 变慢

缓解：

- path guard 继续只读取 `task-plan.yaml`；
- detail 文件不参与写权限决策。

### 多文件原子性问题

缓解：

- 只有 `task-plan.yaml` 拥有可变运行时状态，即 `status` 和 `attempt`；
- detail 文件是 planning artifact，正常 implementation tick 中不应重写；
- coordinator 像现在一样原子写 plan state。

## 验收标准

- AC-001: 现有单文件 `task-plan.yaml` plan 继续可以 parse、dispatch，并通过当前测试。
- AC-002: 带 `detail_ref` 的 task 在 dispatch 时，其 detail 文件位于 `context_paths` 第一位。
- AC-003: 必需 detail 文件在 dispatch 前完成校验；缺失、不安全或 task ID 不匹配时，以确定性诊断阻止 dispatch。
- AC-004: `allowed_write_paths`、dependencies、statuses、attempts、planned tests 和 risk 仍然来源于 `task-plan.yaml`。
- AC-005: implementation-worker 指令将 `task_detail_path` 声明为存在时的必读 context input。
- AC-006: plan-agent standard 要求复杂计划保持 `task-plan.yaml` 紧凑，并将长业务逻辑步骤放入 `task-details/<task-id>.yaml`。
- AC-007: task detail 可以包含 `acceptance_context`、`verification_map` 和 `review_focus`，且这些字段只能引用当前 task 已有的 AC 与 planned cases。

## 推荐实施顺序

1. 为 `detail_ref` 和 `TaskDetailSchema` 添加 schema 与 roundtrip 支持。
2. 为可选 detail 文件添加 packet 注入。
3. 为 high-risk / exclusive complex task 添加 required-detail 检查。
4. 更新 plan-agent 和 implementation-worker prompts。
5. 添加示例和 fixture 覆盖。
6. 只有当 context-path 注入仍然不足时，再考虑物化 `dispatch/<task-id>.packet.yaml`。

## 待决策项

1. `complexity=complex` 是否应立即要求所有 task 都有 detail 文件，还是首版只要求 `risk=high` / `exclusive` task？
2. `task-details/*.yaml` 是否应纳入 human plan signoff hash，还是 v1 只校验存在性和 task ID 匹配？
3. `task_detail_path` 是否从 v1 开始就是显式 `WorkerPacket` 字段，还是只 prepend 到 `context_paths` 就足够？

建议：

- v1 只要求 `risk=high` / `exclusive` complex task 提供 detail 文件。
- v1 在 `WorkerPacket` 中新增显式 `task_detail_path`。
- v1 暂不增加 signoff hash 语义，直到现有 plan signoff 路径确实需要它。

