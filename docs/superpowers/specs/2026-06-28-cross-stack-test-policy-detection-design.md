# 跨技术栈测试策略检测设计

## 背景

Loop Engineering 当前实施标准要求 worker 跟随仓库既有测试风格, 但这是软约束。对于企业项目, 更常见的要求是明确规定测试框架、测试替身、运行命令和覆盖率口径。例如 Java + Spring 项目可能要求 JUnit Jupiter、Spring Boot Test、MockMvc、Testcontainers, 并禁止 JUnit4 或某些 Mockito 用法; JS/TS 项目可能要求 Vitest、Testing Library、Playwright, 并禁止 Jest、Enzyme 或 `.skip` 掩盖 planned case。

如果这些要求只写在 prompt 或文档里, worker 可能在实现阶段临场选择熟悉的框架, 最终 `tests_green: true` 也无法证明它遵守了项目级测试策略。因此需要把测试策略上升为结构化配置, 并由 coordinator 在计划、派发、任务自检和收口阶段进行机械检测。

**迁移期挑战 (本设计必须正面解决):** 企业项目几乎都存在历史 legacy 测试代码 (从 jest 迁 vitest、从 JUnit4 迁 JUnit5)。如果 gate 扫描全仓库, 第一次跑就会把所有 task 全部判违规回流, 推不动。因此本设计的 strict 检测**只判本 task 实际新增的违规**, 历史违规走 advisory baseline。

## 最终决策

采用 "统一 style profile + 技术栈 adapter + worker-facing guidance + style compliance gate" 的方案。

核心原则:

1. 测试策略是计划/配置层契约, 不是 worker 自由发挥的建议。
2. profile 只表达规则, 不绑定具体语言实现。
3. 检测由技术栈 adapter 完成。Java/Spring、JS/TS 等项目各有 adapter, 但输出统一的 `style_compliance` 结果。
4. **硬/软边界分清 (协作范式红线, 对齐 design §0.2 key-diffs 模式):** gate 只对"机制能机械证明的事"判 strict; worker 自报告的运行元数据 (runner 名字、coverage 数字) 老老实实走 advisory, 不假装机制能证明。
5. **strict 检测只看本 task 的 `git diff +` 行**: 历史违规不抓, 仅在 baseline 报告里 advisory。
6. 违反 strict 规则的 task 不得进入 `complete` / `VERIFIED`, 必须回流 rework 或触发 plan amendment。

## 目标

1. 支持在计划/配置层声明项目级测试框架要求。
2. 支持 JS/TS 首批 adapter; Java/Spring adapter 等参考项目验证后再合并 (非首版)。
3. 在 worker packet 中传递测试策略上下文, 避免 worker 只看到笼统实现任务。
4. 在 task 自检阶段检测**本 task 写入范围内**的测试策略违规 (非全仓库)。
5. 在 wrap-up 阶段汇总所有 task 的 style compliance, 作为硬 gate。
6. 产出可机器消费的违规报告, 便于 coordinator 精准回流。

## 非目标

- 不在本设计中实现完整 Java AST 或 TypeScript AST 解析器。
- 不替代现有 test-design checks、task check、key-diffs gate 和 actual_writes。
- 不强制所有项目必须有 style profile; 没有 profile 时降级为现有软规则。
- 不要求 worker 自报依赖、测试框架或执行命令的**真实性** (B 选项: 文件存在 = 硬 gate, 字段真实性 = advisory)。
- 不扫全仓库历史 legacy 代码; 历史违规走 baseline advisory, 不阻塞 task。
- **不支持同语言按路径分策略** (例如同一 monorepo 内 package A 容忍 jest-legacy、package B 强制 vitest)。v1 规则按语言全局生效, 迁移期差异主要由 `baseline_mode` 吸收; 真正异构 monorepo 的需求出现后, 再在 profile 引入 per-path scope (可与上述 file-glob 版 `required_imports` 合并设计)。
- 不在 CLI 中增加交互式选择测试框架的 prompt。
- 不把所有技术栈教程塞进 implementation-worker 的全局 prompt; worker 只接收本 task 相关的短 guidance。
- 不引入密码学防伪、时序快照、独立复跑通道 (那是 §5 `unattended` 档的事, 本设计在 collaborative 档内完成)。

## 概念模型

### Style Profile

`style-profile.yaml` 是项目或 run 级配置, 描述测试策略。它可以由仓库根目录提供, 也可以由 planning 阶段为本次 run 生成。

示例:

```yaml
schema: loop-engineering.style-profile.v1
project:
  languages: [typescript]
  frameworks: [react]
test_policy:
  default_enforcement: advisory   # 默认 advisory, 企业策略稳定后人工切 strict
  baseline_mode: advisory_on_existing   # 历史违规 advisory, 仅新增违规 strict
  adapters:
    js_ts:
      package_managers: [npm, pnpm, yarn]
      required_frameworks: [vitest]
      forbidden_frameworks: [jest, enzyme]
      required_imports_any:        # v1 走 advisory (文件→测试类型反查链不可靠, 见 JS/TS Adapter 静态检测)
        component_test:
          - "@testing-library/react"
      forbidden_imports:
        - enzyme
      forbidden_patterns:
        - "\\b(test|it|describe)\\.skip\\b"
      required_commands:
        - npm test
      coverage:
        min_lines: 80
    java_spring:
      required_dependencies:
        - org.junit.jupiter:junit-jupiter
        - org.springframework.boot:spring-boot-starter-test
      forbidden_imports:
        - org.junit.Test
        - org.junit.runner.RunWith
      required_imports_any:
        controller_test:
          - org.springframework.test.web.servlet.MockMvc
      required_commands:
        - mvn -B test
```

**字段说明 (与首版关键差异):**

- `default_enforcement: advisory` —— 默认 advisory, 而非 strict。企业策略刚落地几乎都是迁移期, 一刀切 strict 会阻塞现有项目推进。策略稳定后人工切 strict。
- `baseline_mode: advisory_on_existing` —— 历史 legacy 违规走 advisory (仅在 baseline 报告中提示), strict 只判**本 task 新增的违规**。可选值 `strict_on_existing` (全卡, 仅适合 greenfield 项目)。

### Guidance Source

profile 可以直接携带 `guidance` 字段, 也可以只携带机器规则, 由 generator 根据 adapter 默认模板生成 guidance。推荐规则:

1. 企业或团队有固定测试写法时, 在 profile 中声明 `guidance.summary`、`preferred_test_patterns`、`command_recipes` 和短 example skeleton。
2. profile 没写 guidance 时, adapter 使用内置默认模板生成最小说明, 例如 Vitest / JUnit Jupiter 的 import skeleton 和 required command。
3. **guidance 是 generator 从 profile 确定性派生的, 不是另一套规则源**。所谓 "guidance 与 profile drift" 实际等价于 "generator bug" —— 通过 generator 单元测试 + 派生过程纯函数化来防, 不是运行时检测。
4. guidance 必须控制长度, 目标是 worker 开工前 30 秒内读完。

### Enforcement Level

每条规则必须有明确执行级别:

- `strict`: 违规导致 gate fail, task 必须 rework。
- `advisory`: 只产生 warning, 不阻断收口。
- `disabled`: profile 中暂存规则, 但本次不执行。

默认推荐 `advisory`, 迁移期完成、策略稳定后再人工切 strict。

**B 选项核心约束 —— runner/coverage 字段永远走 advisory:** 无论规则的 `enforcement` 字段是 strict 还是 advisory, command evidence 中的 `runner.name`、`coverage_lines` 等运行元数据字段**永远按 advisory 处理**。理由: 这些字段是 worker 自报告的 (hallucination 高危点, 见 design §0.2), 机制无法机械证明其真实性。gate 对它们只校验"字段存在 + 类型正确", 不当 strict violation 依据。

### Style Compliance Result

所有 adapter 输出统一结构:

```yaml
schema: loop-engineering.style-compliance.v1
task_id: T01
passed: false
adapter_results:
  - adapter: js_ts
    passed: false
    violations:
      - code: js.test.forbidden_framework
        severity: strict
        scope: diff_added   # strict 违规只在 diff_added 范围内判
        file: package.json
        line: 12
        detail: jest is forbidden; use vitest
      - code: js.test.skip_detected
        severity: strict
        scope: diff_added
        file: src/UserForm.test.tsx
        line: 45
        detail: planned test file contains test.skip in newly added lines
warnings:
  - code: js.test.runner_mismatch
    severity: advisory
    scope: command_evidence
    detail: profile requires vitest, evidence runner.name="jest" (self-reported, unverified)
  - code: js.test.legacy_forbidden_import
    severity: advisory
    scope: baseline
    file: src/__tests__/legacy.test.js
    detail: 3 historical jest imports found in baseline; not blocked
evidence:
  actual_writes_source: git
  diff_line_extractor: git_diff_plus
  command_evidence_source: worker_self_report   # 明示采集源
  command_evidence_paths:
    - tasks/T01/command-evidence/npm-test.json
```

## 检测架构

```text
style-profile.yaml
        |
        v
Style Profile Resolver --------> Style Baseline Builder (一次性, 全仓库 advisory 扫)
        |                                |
        v                                v
Style Guidance Generator          planning/style-baseline.json
        |                                |
        v                                |
WorkerPacket.context_paths              |
        |                                |
        v                                |
implementation-worker                   |
        |                                |
   +----+----+                           |
   v         v                           |
actual_writes  command-evidence.json     |
   |         (worker self-report)        |
   v         |                           |
Git Diff +Line Extractor                 |
   |         |                           |
   v         v                           v
+---------------------+         Command Evidence Reader
|  Technology Adapter |                 |
|  Registry           |                 |
|  +---------+        |                 |
|  | js_ts   |        |                 |
|  +---------+        |                 |
|  +---------+        |                 |
|  | java_spring|     |                 |
|  +---------+        |                 |
+---------------------+                 |
        |                               |
        v                               v
   Style Compliance Gate <----- compare against baseline
        |
        v
   strict violations (diff_added scope only) ---> rework
   advisory warnings (any scope) --------> record only
```

> **图注 (baseline 与 gate 的关系, v1):** 上图 "compare against baseline" 仅用于**生成 advisory 历史违规 warning**; **strict 判定纯看本 task 的 git diff + 行, 不依赖 baseline**。改名/移动把旧违规带进 diff 的误判, v1 靠 `git diff -M` 缓解; "从 diff-新增里扣除 baseline 已知的同一违规" 这条更强的抑制留到 Phase 5 (baseline 在 Phase 5 才建)。

### Profile Resolution

解析顺序 (前者覆盖后者):

1. run 目录中的 `planning/style-profile.yaml`。
2. **目标项目** (被安装方) 仓库根目录中的 `.loop/style-profile.yaml`。
   - 注: 此目录是面向目标项目的约定, 与该项目的 `.claude/` 同级; 不是 run 目录里的产物, 也不是实现仓库的目录。
3. 未找到时返回 `null`, 保持现有软规则。

> 历史选项 `.e2e-loop/style-profile.yaml` 已删除: 该前缀是 adapter 包名 (`@e2e-loop/adapter-claude-code`), 不是配置目录约定, 易混淆。

解析失败时:

- schema 非法: planning/prepare 阶段 fail。
- adapter 名称未知: strict profile fail, advisory profile warning。
- 规则字段不合法: fail, 并指明 YAML path。

### Worker Packet

`WorkerPacket.context_paths` 继续承载最小必读上下文。解析到 style profile 后, coordinator 将其路径加入 packet:

```text
planning/design.md
planning/task-plan.yaml
planning/style-profile.yaml
planning/style-guidance.md
```

worker 职责:

- 必须阅读 style profile。
- 必须阅读 generated style guidance。
- 必须按 profile 写测试和选择测试框架。
- 如果 planned case 与 profile 冲突, 返回 `plan-amendment-needed`, 不能擅自换框架或弱化测试。

#### 多 adapter 并存处理

monorepo (Java 后端 + React 前端) 是企业策略的主要应用场景。当本 task 的 `actual_writes` 同时触及 Java 与 JS/TS 文件时:

- `style_context.active_adapters` 是数组, 列出所有触发的 adapter, 例如 `["js_ts", "java_spring"]`。
- `style-guidance.md` 内部按 adapter 分段 (二级标题分隔), 每段独立 Use/Do/Avoid/Skeleton/Commands, 不混排规则。
- gate 对每个 adapter 独立运行, 任一 strict 违规即 fail。

### Worker-facing Guidance

仅有检测会增加摩擦: worker 到收口才知道错在哪里, 会进入 "写一次、被 gate 打回、再猜一次" 的循环。设计上必须让 profile 在派发前生成一份 task-local guidance, 作为 worker 的操作说明。

guidance 不是另一套规则源。它由 `style-profile.yaml` 派生, 面向 agent 阅读; profile 仍是机器判定的唯一契约。两者不一致时**以 profile 为准**。

**drift 防护机制 (修订):** 原设计写"profile/guidance drift 运行时检测", 但 guidance 是 generator 从 profile 派生的纯函数输出, drift 只可能源于 generator bug。正确形态是:
1. generator 是纯函数, 无 LLM 参与, 无外部状态。
2. generator 单元测试覆盖所有 adapter × 所有 profile 字段组合。
3. 若 worker 反馈 guidance 与 profile 不一致, 视为 generator bug, fail-loud 上报, 不在 task 级运行时降级。

生成路径:

```text
planning/style-guidance.md
```

需要更细粒度时, 也可以按 task 生成:

```text
tasks/<id>/style-guidance.md
```

worker packet 应扩展为:

```json
{
  "context_paths": [
    "planning/design.md",
    "planning/task-plan.yaml",
    "planning/style-profile.yaml",
    "planning/style-guidance.md"
  ],
  "style_context": {
    "profile_path": "planning/style-profile.yaml",
    "guidance_path": "planning/style-guidance.md",
    "active_adapters": ["js_ts"],
    "required_commands": ["npm test"]
  }
}
```

`style_context` 是便利字段, 不替代 `context_paths`。即使不扩展 packet schema, 首版也必须把 guidance 文件加入 `context_paths`, 让 worker 在实现前自然读到。

#### Guidance 内容模板

guidance 必须短、具体、可执行。推荐结构:

````markdown
# Test Style Guidance for T01

## Active Adapters: js_ts

## Use (js_ts)

- Test runner: Vitest.
- Component testing: @testing-library/react.
- Command evidence required: npm test.

## Do (js_ts)

- Import test APIs from vitest.
- Use render/screen/userEvent for React component behavior.
- Keep each planned case mapped to one test or one describe block with clear assertions.

## Avoid (js_ts)

- Do not add Jest or Enzyme.
- Do not use test.skip / it.skip / describe.skip.
- Do not replace planned checks with weaker assertions.

## Example Skeleton (js_ts)

```ts
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
```

## Required Commands (js_ts)

```text
npm test
```
````

Java/Spring guidance 示例 (与本 task 的 active_adapters 段并列):

```markdown
## Active Adapters: java_spring

## Use (java_spring)

- Test runner: JUnit Jupiter.
- Spring test support: spring-boot-starter-test.
- Controller slice: @WebMvcTest + MockMvc.
- Command evidence required: mvn -B test.

## Do (java_spring)

- Import org.junit.jupiter.api.Test.
- Use MockMvc for controller request/response assertions.
- Use Testcontainers or MockServer for external integration boundaries when the profile requires it.

## Avoid (java_spring)

- Do not import org.junit.Test or org.junit.runner.RunWith.
- Do not use @Disabled to hide a planned case.
- Do not replace MockMvc controller tests with direct service calls when the planned case is HTTP behavior.
```

### Skill 与标准改造

为降低 agent 摩擦, 不能只改 gate, 还要改 worker skill 与实施标准:

1. `implementation-worker` 的"输入"部分增加 `style_context` / `style-guidance.md`。
2. `implementation-worker` 的"职责"部分增加: 先读 style guidance, 再写测试。
3. `implementation-standard.md` 的"测试怎么写"增加一条: 如果 packet 包含 style guidance/profile, 测试框架、mock 工具、命令必须以它为准; 与仓库既有风格冲突时上报 amendment, 不自行折中。
4. `test-design-standard.md` 在 planning 侧增加: 设计 planned cases 时应标注测试类型, 例如 `unit`、`controller`、`component`、`integration`、`e2e`, 供 guidance generator 选择正确规则。
5. 如果 task 类型无法判定, guidance 应给出最小安全默认值, 并要求 worker 在 summary 中说明选择原因。

#### Hook 接入 (新增, 修订关键点)

- **`post_task_collect.py` (PostToolUse Task)**: 在必需 artifact 校验清单中增加 `tasks/<id>/command-evidence/<command>.json` (仅当 profile 存在时要求)。worker 仍在上下文里时被抓, 比到 wrap-up 才抓省一次往返 —— 这与现有 `test-results.yaml / summary.md / key-diffs.yaml` 的处理同构, 不引入新模式。
- **`task_check` 兼容性 (关键)**: 无 profile 时**不加入 `style_compliance` 项**, 让无 profile 的 run 行为逐字不变。注: 现有 task_check 测试是按 check 名过滤断言 (`items.filter(i => i.check === "tests_green")`), **不**断言 `items` 总数, 所以"有 profile 时加第 5 项"本身不会破现有测试; 选"无 profile 不加项"是为了让无 profile 路径零新分支, 不是为了凑数量。验收 #1 在此落实。
- **`guard_paths.py` (PreToolUse Write|Edit)**: `style-profile.yaml` 不在任何 task 的 `allowed_write_paths` 内, 永远 deny —— 防 worker 为过 gate 改 profile。

这个改造把规则从"事后失败原因"前移成"开工前的路线图"。gate 仍然存在, 但它主要防漂移、防漏跑、防误用, 而不是让 worker 靠失败反馈学习规则。

### Adapter Registry

style gate 根据 profile 和**本 task 的 actual_writes** 选择 adapter (不扫全仓库):

| Adapter | 触发条件 | 主要输入 |
| --- | --- | --- |
| `java_spring` | actual_writes 内含 `.java` 文件, 且 profile 显式声明 java_spring 段 | actual_writes 内 Java 文件的 diff + 行、command evidence |
| `js_ts` | actual_writes 内含 `.js/.ts/.tsx/.jsx` 文件, 且 profile 显式声明 js_ts 段 | actual_writes 内 JS/TS 文件的 diff + 行、package.json diff、command evidence |

**触发原则:**

- 触发基于 **actual_writes** (task 改动面), 不是全仓库特征。纯 README / 文档 task 不触发任何 adapter, 零摩擦。
- 如果 actual_writes 同时含 Java 和 JS/TS 文件, 且 profile 同时声明了两段, 则两个 adapter 都运行。所有 strict adapter 必须通过。
- 如果 profile 声明了某 adapter, 但本 task actual_writes 不含对应语言文件, 该 adapter 不触发 (跳过, 不 fail)。

## Java/Spring Adapter (首版推后, 见分阶段落地)

### 静态检测

**检测范围 (修订关键点):**

- strict 检测对象 = 本 task `actual_writes` 内 Java 文件的 **git diff + 行**。
- advisory baseline 检测对象 = 全仓库 `src/test/java/**/*.java` (一次性, 落 `planning/style-baseline.json`)。
- POM/Gradle 依赖: 只检**本 task 新增依赖** (build 文件的 diff + 行), 不检全文件依赖历史。

检测项 (strict, 仅判 diff + 行):

1. 新增依赖是否触犯 forbidden dependencies (例如 JUnit Vintage)。
2. 新增 import 是否在 forbidden 列表中 (例如 `org.junit.Test`)。
3. 新增 annotation 是否触犯 forbidden (例如 JUnit4 `@RunWith`)。
4. 新增代码是否触犯 forbidden patterns (精确正则, 见精度约束)。

> `required_imports_any` (例如 controller test 必须 MockMvc) 同 JS/TS adapter, **v1 走 advisory** —— "文件 → 测试类型"反查链不可靠, 详见 JS/TS Adapter 静态检测说明。

检测项 (advisory, 全仓库 baseline):

1. 历史 `org.junit.Test` import 数量。
2. 历史 JUnit Vintage 依赖存在性。
3. 历史 `@Disabled` 数量。

**首版精度约束 (避免误报):**

- 首版只扫 **import 行** (`^import\s+...`) 与 **行首 annotation** (`^@\w+`), 不扫代码块。
- "忽略注释块和字符串字面量" 不在首版承诺范围内 —— 这种规则标记为 `disabled`, 不当 strict。
- 后续可升级为 JavaParser AST (Phase 6)。

### 运行证据检测

检测项 (advisory only, B 选项核心约束):

1. 是否存在 profile 声明的 Maven/Gradle 测试命令 evidence **文件** (strict: 文件缺失则 fail)。
2. 命令 exit_code 字段值 (advisory: 字段是 worker 自报告, 不机械证明)。
3. runner.name 字段 (advisory: 同上)。
4. Surefire/Failsafe/Gradle test 输出实际执行 (advisory: 解析 stdout, 不当 strict)。
5. planned case 被 `@Disabled` 掩盖 (strict: 在 diff + 行内检测 `@Disabled` 注解)。

如果项目是多模块 Maven, adapter 应优先接受等价命令:

```text
mvn -B -pl <module> -am test
```

但必须能证明它覆盖了本 task 修改模块。

## JS/TS Adapter (首版)

### 静态检测

**检测范围 (修订关键点):**

- strict 检测对象 = 本 task `actual_writes` 内 JS/TS 文件的 **git diff + 行**。
- advisory baseline 检测对象 = 全仓库 `*.test.*` / `*.spec.*` (一次性 baseline)。
- package.json 依赖: 只检**本 task 新增依赖** (package.json 的 diff + 行), 不检全文件依赖历史。

检测项 (strict, 仅判 diff + 行):

1. 新增 dependency/devDependency 是否触犯 forbidden frameworks。
2. 新增 import 是否在 forbidden 列表 (精确匹配 import 行)。
3. 新增测试代码是否触犯 forbidden patterns (`\b(test|it|describe)\.(skip|only)\b` 等精确正则)。

> `required_imports_any` (例如 component test 必须 import `@testing-library/react`) **v1 走 advisory, 不判 strict**。原因: 它要先把"写出来的测试文件"映射到 planned case 的测试类型 (component/controller/…), 而"文件 → 类型"这条反查链 v1 没有可靠机械依据 (plan 里标了类型, 但 actual_writes 给的是文件), 强判 strict 会误 fail。升级路径二选一: (a) profile 改成按 file-glob 绑定 (`component_test: { files: ["**/*.test.tsx"], require: [...] }`), 文件级可直接判即可升 strict; (b) Phase 6 上 AST 后类型推断足够可靠再升 strict。

检测项 (advisory, 全仓库 baseline):

1. 历史 jest/enzyme 依赖数量。
2. 历史 forbidden import 出现位置。
3. 历史 `test.skip` / `it.skip` 数量。

检测项 (混合 strict/advisory, 依赖 evidence):

1. **command-evidence.json 文件存在性 + 必需字段存在/类型** = strict (文件缺失或 strict 字段缺失 = fail; 这是 coordinator 能独立确认的唯一事实 —— 文件在不在、字段齐不齐)。
2. **command 字段值匹配 required_commands** = advisory (该值与 exit_code/runner 同源, 都是 worker 写进同一份 JSON 的, 不机械证明真实性)。
3. **exit_code == 0** = advisory (字段值是 worker 自报告)。
4. **runner.name 匹配 required framework** = advisory (字段值是 worker 自报告)。
5. **coverage_lines >= min_lines** = advisory (字段值是 worker 自报告)。

> **strict 边界的诚实声明:** 文件存在性 strict 只能证明 "worker 走了流程、留了痕", 不能证明 "测试真跑了" (`echo '{...}' > file` 也能过)。这与 key-diffs 硬 gate 同构 (文件存在且非空 = 硬 gate, 内容真实性 = 软约束); 升 `unattended` 档接入 coordinator 独立复跑通道 (design §0.3) 后, 这些 advisory 字段才可升 strict。

JS/TS 首版实现用 `package.json` 结构化解析 + 测试文件 import 行正则扫描。

### 等价命令判定 (修订)

解析深度只到 `package.json` `scripts.test` **一层**, 深一层标 advisory:

- `npm test` 解析为 `scripts.test` 字段值; 若该值含 `vitest run` 字面量 → 视为 vitest evidence。
- 若 `scripts.test` 是 `node scripts/run-tests.js` 这种自定义脚本, 内部 spawn 什么不解析 → 标 advisory "command 等价性未能机械证明"。
- 直接 `npx vitest run` 可接受为 `vitest` runner evidence。
- 若 profile 明确 `exact_command: true`, 则只接受完全匹配, 不做等价推断。

## Gate 接入点

### Task 自检

在现有 task check 中, **仅当 style profile 存在时**增加一项:

```text
style_compliance
```

**无 profile 时**: 完全不加入此项, 无 profile 路径行为逐字不变 (验收 #1)。

输入:

- task。
- style profile (若存在)。
- actual writes + git diff + 行。
- command evidence。
- workdir。
- baseline report (来自 planning 阶段的一次性扫描)。

判定 (有 profile 时):

- adapter 全部 strict pass (无 diff_added scope 内的 strict violation): pass。
- 任一 strict violation (diff_added scope): fail。
- 仅 advisory violation (含 baseline / runner / coverage): pass with warnings。

### Wrap-up 自检

在 wrap-up 中增加聚合项:

```text
all_style_compliance_pass
```

判定:

- profile 不存在: 不加入此项 (保持现有行为)。
- profile 存在: 所有 task 的 `style_compliance.passed == true` 才通过。
- 缺失某 task style-compliance 结果时, 如果 profile 存在则 fail。

### Rework 路由

违规回流规则:

| 违规类型 | scope | 路由 |
| --- | --- | --- |
| forbidden import/framework/pattern (diff_added) | strict | 回 implementation worker 修改测试 |
| required command evidence 文件缺失 | strict | 回 worker 补 evidence 文件 |
| command 值 / runner / coverage 不匹配 | advisory | 记录 warning, 不回流 (字段值 worker 自报告) |
| planned case 与 profile 冲突 | strict | `plan-amendment-needed` 回 planning |
| profile schema 非法 | strict | prepare/planning 阶段 fail, 人工修 profile |
| runner.name mismatch | advisory | 记录 warning, 不回流 |
| coverage 不达标 | advisory | 记录 warning, 不回流 |
| baseline 内历史违规 | advisory | 记录 warning, 不回流, 鼓励项目级清理 |
| required_dependencies 项目级缺失 | advisory | planning/prepare 一次性 warn, 不在 task 级跑 |

## Command Evidence 契约

style gate 需要结构化 command evidence, 而不是从聊天文本猜测。每次测试命令落盘:

```json
{
  "schema": "loop-engineering.command-evidence.v1",
  "task_id": "T01",
  "command": "npm test",
  "cwd": "packages/web",
  "exit_code": 0,
  "started_at": "2026-06-28T09:00:00-07:00",
  "ended_at": "2026-06-28T09:00:12-07:00",
  "stdout_path": "tasks/T01/command-evidence/npm-test.stdout.txt",
  "stderr_path": "tasks/T01/command-evidence/npm-test.stderr.txt",
  "runner": {
    "name": "vitest",
    "version": "unknown"
  },
  "summary": {
    "tests": 12,
    "failed": 0,
    "skipped": 0,
    "coverage_lines": 84.1
  },
  "collected_by": "worker_self_report",
  "advisory_only_fields": ["runner", "summary.coverage_lines"]
}
```

**字段语义 (B 选项核心约束):**

- **strict 字段** = `schema`、`task_id`、`command`、`cwd`、`stdout_path`、`stderr_path`、`exit_code` 的**存在性与类型** (不含字段**值**是否匹配 required_commands —— 值匹配走 advisory)。这些是 coordinator 能独立确认的文件级客观事实, 缺失即 fail。
- **advisory 字段** = `runner`、`summary.*`。这些是 worker 自报告的运行元数据, 字段值不机械证明真实性 (hallucination 高危点, design §0.2)。gate 只校验"字段存在 + 类型正确", 不当 strict violation 依据。
- `collected_by: worker_self_report` 明示采集源 (artifact-first, design §0.4); 未来升 `unattended` 档时改为 `coordinator_independent_replay` (接 design §0.3 保留的独立复跑通道), schema 不动, B → A 平滑升级。

**首版最小要求:** worker 必产 strict 字段; advisory 字段可选, 缺失只 warning 不 fail。

## 数据结构建议

新增 schema:

```text
packages/ssot-ts/src/schema/style_profile.ts        # 含 baseline_mode, default_enforcement
packages/ssot-ts/src/schema/style_compliance.ts     # 含 scope (diff_added/baseline/command_evidence)
packages/ssot-ts/src/schema/style_baseline.ts       # advisory baseline 报告
packages/ssot-ts/src/schema/command_evidence.ts     # 含 collected_by, advisory_only_fields
```

新增 checklists / 工具:

```text
packages/ssot-ts/src/checklists/style_compliance.ts
packages/ssot-ts/src/style_guidance/generator.ts    # 纯函数, 无 LLM
packages/ssot-ts/src/style_adapters/index.ts
packages/ssot-ts/src/style_adapters/js_ts.ts        # 首版
packages/ssot-ts/src/style_adapters/java_spring.ts  # Phase 4, 推后
packages/ssot-ts/src/scheduling/diff_plus_extractor.ts  # git diff + 行抽取 (复用 actual_writes 基础设施)
```

新增测试:

```text
tests-ts/ssot/style_profile.test.ts
tests-ts/ssot/style_compliance_js_ts.test.ts
tests-ts/ssot/style_compliance_diff_scope.test.ts   # 关键: 历史 legacy 不 fail, 新增违规 fail
tests-ts/ssot/style_baseline.test.ts
tests-ts/ssot/wrap_up_style_compliance.test.ts
tests-ts/ssot/style_guidance_generator.test.ts
tests-ts/ssot/diff_plus_extractor.test.ts
tests-ts/ssot/command_evidence_schema.test.ts
```

## 验收标准

1. **没有 style profile 的现有 run 行为不变**: `task_check` 不加入 `style_compliance` 项, 无 profile 路径不引入任何新分支 (现有测试按 check 名过滤、不断言 items 总数, 天然不受影响)。
2. 有 JS/TS profile 且本 task **新增**测试文件 import `jest` 时, `style_compliance` fail。
3. 有 JS/TS profile 且本 task **新增**测试代码包含 `test.skip` 时, `style_compliance` fail。
4. ~~有 JS/TS profile 要求 Vitest, 但 command evidence 显示 Jest runner 时, `style_compliance` fail。~~ **改为**: 上述情况仅产生 advisory warning, 不 fail (B 选项: runner 字段是 worker 自报告, 不机械证明)。
5. 有 Java/Spring profile 且本 task **新增**测试 import `org.junit.Test` 时, `style_compliance` fail。
6. 有 Java/Spring profile 要求 `mvn -B test`, 但缺 command evidence **文件**时, `style_compliance` fail (文件级 strict)。
7. 解析到 style profile 后, worker packet 包含 `style-guidance.md` 或等价 `style_context`。
8. guidance 中包含当前 active adapter 的 Use / Do / Avoid / Example Skeleton / Required Commands; 多 adapter 时按 adapter 分段。
9. advisory violation 不阻断 task complete, 但在结果中保留 warning。
10. wrap-up 在任一 strict style violation 存在时 fail。
11. **新增: 历史 legacy 违规不在 actual_writes diff + 行内时, 不触发 strict fail, 仅进 baseline advisory。**
12. **新增: 多 adapter task (Java + JS/TS 同时触及) 时, packet `active_adapters` 列出全部, guidance 分段。**
13. **新增: 纯 README / 文档 task 不触发任何 adapter, `style_compliance` 自动 pass。**

> **AC ↔ 首版范围:** #1/#2/#3/#7/#8/#9/#10/#11/#12/#13 为首版 (JS/TS) gating; #5/#6 属 Java/Spring adapter, 随 Phase 4 推后, 不阻塞首版; #4 已废弃 (见上方删除线)。

## 分阶段落地

### Phase 1: Profile、结果 schema 与 guidance schema

- 增加 `style_profile.ts` (含 `baseline_mode`、`default_enforcement`)。
- 增加 `style_compliance.ts` (含 `scope` 字段)。
- 增加 `style_baseline.ts`、`command_evidence.ts`。
- 增加 style guidance generator (纯函数, 无 LLM)。
- 增加 YAML 读写支持。
- 增加 schema 与 guidance 单元测试。

### Phase 2: Worker skill 与 hook 接入

- 扩展 `implementation-worker` 输入说明, 加入 style guidance。
- 扩展 `implementation-standard.md`, 明确 profile/guidance 优先级。
- 扩展 packet 构造, 把 guidance path 放进 `context_paths`。
- **`guard_paths.py` 永远 deny `style-profile.yaml` 写入** (无需 adapter, 可独立落地)。
- **`task_check` 兼容性骨架: 无 profile 不加项**。注: 有 profile 的"加第 5 项"分支等 Phase 3 adapter 就绪再激活, 避免本阶段加了项却没人算它。

### Phase 3: JS/TS adapter MVP (首版核心)

- 实现 `diff_plus_extractor.ts` (git diff + 行抽取, 复用 actual_writes 基础设施; 开 `git diff -M` 识别改名, 见风险表 D)。
- 解析 `package.json` 的 diff + 行 (新增依赖)。
- 扫描测试文件 diff + 行的 import 行与 skip/only 正则。
- 检查 command evidence 的 strict 部分 (文件存在 + 必需字段存在/类型); command 值匹配 / runner / coverage 一律 advisory。
- **`post_task_collect.py` 必需 artifact 清单加入 `command-evidence.json` (仅 profile 存在时)** —— 与消费它的 adapter 同期落地, 不在 Phase 2 提前要求。
- **激活 task_check 有 profile 分支 (加第 5 项 `style_compliance`)**。
- 接入 task check。
- **关键回归: 历史 legacy 违规不 fail; 改名/移动带出的旧违规不误判 strict。**

### Phase 4: Java/Spring adapter (推后)

**前置条件: 在 Spring PetClinic 等参考项目跑通后再合并, 不在首版发布。**

- 解析 Maven/Gradle 依赖 diff。
- 扫描 Java 测试文件 diff + 行的 import / annotation。
- 检查 Maven/Gradle command evidence。
- 接入 task check。

### Phase 5: Wrap-up、baseline 与 rework 路由

- 增加 wrap-up 聚合项。
- 缺失 style compliance 结果时按 profile 存在与否判定。
- 实现 `style_baseline.ts` 一次性全仓库扫描 (planning 阶段)。
- 将 violation code 映射为 worker rework reason (strict) 或 warning (advisory)。

### Phase 6: AST 与 effective dependency 增强

- Java 使用 JavaParser 或等价 AST。
- JS/TS 使用 TypeScript compiler API 或 Babel parser。
- Maven 支持 effective POM, Gradle 支持 dependency insight。
- 此时可考虑把部分原 advisory 规则升级为 strict (因 AST 精度足够)。

## 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| **历史 legacy 违规被算到新 task 头上 (迁移期大爆炸)** | **strict 限定到 git diff + 行; 全仓库扫降级为 baseline advisory; profile 提供 `baseline_mode` 字段让团队显式选迁移策略。改名/移动把旧违规带进 diff: v1 用 `git diff -M` 缓解, Phase 5 加 "diff-新增 ⊖ baseline" 扣减彻底消除** |
| 文本扫描误报 | 首版只扫 import 行与行首 annotation; 复杂规则标 advisory 或 disabled |
| 多模块依赖继承难判 | 允许 command evidence 补强; 后续加 effective POM (Phase 6) |
| JS runner 等价命令复杂 | profile 支持 `exact_command: true`; 深一层脚本调用标 advisory |
| 规则过严阻碍迁移 | enforcement 默认 advisory; baseline_mode 默认 `advisory_on_existing` |
| 只做检测导致 worker 反复返工 | profile 生成短 guidance 并注入 packet; `post_task_collect` 在 worker 仍在上下文时抓文件缺失 |
| worker 为过 gate 修改 profile | profile 不在 task `allowed_write_paths` 内; `guard_paths.py` 永远 deny; `actual_writes` 越界检测拦截 |
| **guidance generator drift** | **generator 是纯函数; 单元测试覆盖 adapter × profile 字段组合; drift = generator bug, fail-loud 上报** |
| **多 adapter 并存 guidance 冲突** | **guidance 按 adapter 分段, 不混排规则; gate 各 adapter 独立运行** |
| **command evidence runner/coverage 被幻觉** | **B 选项: 字段存在 strict, 字段值 advisory; `collected_by: worker_self_report` 明示; 未来升 unattended 档可平滑切换** |
| **Java adapter 无 dogfood 场景** | **首版只发 js_ts; Java adapter 推后到 PetClinic 参考项目跑通再合并** |
| task_check 加项破坏现有测试 | 现有测试按 check 名过滤、不断言 items 总数, 加第 5 项不破; 无 profile 仍不加项以保无 profile 路径零新分支 |

## 设计结论

跨技术栈测试策略不应按语言分别堆规则, 而应抽象为统一的 style profile、worker-facing guidance 和 style compliance gate。profile 是机器契约, guidance 是 agent 操作手册, adapter 是技术栈检测实现。

**本设计相对初版的核心修订 (B 选项 + 历史 legacy 友好):**

1. **硬/软边界分清 (对齐 design §0.2):** gate 只对"机制能机械证明的事"判 strict (静态文件存在、diff + 行内的违规); worker 自报告的运行元数据 (runner、coverage) 永远走 advisory。这与现有 `key-diffs.yaml` 的处理同构 (文件存在 = 硬 gate, 内容真实性 = 软约束)。
2. **strict 限定到 git diff + 行:** 历史 legacy 违规走 baseline advisory, 不阻塞 task。这是迁移期可用性的关键。
3. **command evidence collected_by 显式标注:** `worker_self_report` 明示采集源, 不假装独立采集; 未来升 `unattended` 档时可平滑切到 `coordinator_independent_replay`, schema 不动。
4. **Java adapter 推后:** 首版只发 js_ts, 在参考项目验证后再合并 Java。

Java/Spring 与 JS/TS 的差异留在 adapter 中: Java 检 POM/Gradle diff、imports、annotations、Maven/Gradle evidence; JS/TS 检 package.json diff、测试文件 imports、skip/only、command evidence。coordinator 只消费统一结果, 把 strict violation (diff_added scope 内) 当作硬 gate, advisory violation (runner/coverage/baseline) 当作 warning。
