# Run 收口自动 commit / push / PR(finalize)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Loop Engineering 加一条 run 收口后自动 commit → push → 建 draft PR(GitHub)或输出建 MR 链接(内部仓库)的可选发布链路。

**Architecture:** SSOT 新子包 `finalize/` 放确定性纯函数(探测/计划/拼装,可单测);CLI 新子命令 `e2e-loop finalize` 编排有副作用的 git/gh(注入 runner seam 可测);`init` 写入 run 级 `finalize_policy`;提示词层在进入 COMPLETE 后触发。finalize 不改状态机,是 COMPLETE 之后的独立步骤。

**Tech Stack:** TypeScript (ESM, Node 20+), zod, js-yaml;测试用 bun:test(经 `npx bun@1.3.14 test`);无第三方 CLI 解析(用 `util.parseArgs`)。

**规范源 spec:** `docs/superpowers/specs/2026-06-29-auto-finalize-commit-push-pr-design.md`

## Global Constraints

- 代码注释统一用中文(与现有 SSOT 风格一致)。
- 不引第三方依赖;只用 Node 内置 + 已有 zod / js-yaml。
- 测试放 `tests-ts/`,`import { test, expect, describe } from "bun:test"`,从 `packages/.../src/*.js` 直接 import(测 src 不测 dist)。
- 所有 git / gh 子进程强制 `env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }`,杜绝缺凭证交互挂起。
- JSON artifact 原子写:复用 `atomicReplace`(`packages/ssot-ts/src/runtime/directory.ts`)。
- finalize **不写** run-state.json(单写者是 Coordinator),只写 `wrap-up/finalize-result.json`。
- 不改 `worktree-binding.json` schema;commit_sha/pr_url 一律记 finalize-result.json。
- 每个 task 完成跑 `npx tsc --noEmit` 通过后再 commit;commit message 结尾加 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
- 枚举字面量:`finalize_policy ∈ {off, commit, commit_push, full_pr}`;`pr_backend ∈ {github, none}`;`pr_action ∈ {none, auto_create, link_only}`;`achieved ∈ {off, no_changes, commit, commit_push, full_pr}`。

## 文件结构

**新建(SSOT finalize 子包)** `packages/ssot-ts/src/finalize/`:
- `policy.ts` — `requiredChannels(policy)`
- `channel.ts` — `FinalizeChannel` / `probeFinalizeChannel` / `isGithubRemote`
- `push_url.ts` — `extractCreateUrl(pushStderr)`
- `plan.ts` — `FinalizePlanInput` / `FinalizePlan` / `planFinalize`(核心决策)
- `message.ts` — `buildCommitMessage` / `buildPrBody`
- `result.ts` — `FinalizeResultSchema` / `writeFinalizeResult` / `readFinalizeResultOrNull`
- `index.ts` — 子包 barrel 导出

**修改:**
- `packages/ssot-ts/src/schema/run_state.ts` — `FinalizePolicySchema` + run-state 两字段
- `packages/ssot-ts/src/worktree/allocator.ts` — base 解析符号分支名
- `packages/ssot-ts/package.json` — exports 加 `./finalize`
- `packages/cli/src/args.ts` — 加 `finalize` / `no-pr-draft` 选项
- `packages/cli/src/commands/dryrun.ts` — `runInit` 写 finalize 字段
- `packages/cli/src/commands/finalize.ts`(新建)— `runFinalize` 编排
- `packages/cli/src/index.ts` — 注册 `finalize` 子命令
- `core/coordinator.md` + `docs/loop-engineering-master-prompt.md` — 提示词触发
- `changlog.md` — 条目

**测试** `tests-ts/`:`ssot/finalize_policy.test.ts`、`ssot/finalize_channel.test.ts`、`ssot/finalize_push_url.test.ts`、`ssot/finalize_plan.test.ts`、`ssot/finalize_message.test.ts`、`ssot/finalize_result.test.ts`、`finalize_init.test.ts`、`finalize_cli.test.ts`;并扩 `ssot/schema_run_state.test.ts`、`ssot/worktree_allocator.test.ts`。

---

### Task 1: schema — finalize_policy 字段

**Files:**
- Modify: `packages/ssot-ts/src/schema/run_state.ts`
- Test: `tests-ts/ssot/schema_run_state.test.ts`

**Interfaces:**
- Produces: `FinalizePolicySchema`(zod enum)、`FinalizePolicy`(type)、`FinalizePolicy`(常量对象);RunState 新增 `finalize_policy` / `finalize_pr_draft`。

- [ ] **Step 1: 写失败测试** — 追加到 `tests-ts/ssot/schema_run_state.test.ts` 末尾

```ts
import { FinalizePolicySchema } from "../../packages/ssot-ts/src/schema/run_state.js";

describe("finalize_policy", () => {
  test("缺省 → full_pr + draft true", () => {
    const s = parseRunState({ run_id: "r1", complexity: "simple" });
    expect(s.finalize_policy).toBe("full_pr");
    expect(s.finalize_pr_draft).toBe(true);
  });
  test("显式 off 保留", () => {
    const s = parseRunState({ run_id: "r1", complexity: "simple", finalize_policy: "off" });
    expect(s.finalize_policy).toBe("off");
  });
  test("非法 finalize_policy 抛错", () => {
    expect(() => FinalizePolicySchema.parse("merge")).toThrow();
  });
});
```

(注:`parseRunState` / `describe` / `test` / `expect` 已在该文件顶部 import。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npx bun@1.3.14 test tests-ts/ssot/schema_run_state.test.ts`
Expected: FAIL —— `FinalizePolicySchema` 未导出 / `finalize_policy` 为 undefined。

- [ ] **Step 3: 实现** — 在 `run_state.ts` 的 `TrustMode` 枚举段之后加枚举,在 `RunStateSchema` 的 `.object({...})` 里加两字段

枚举(放在 `HumanPending` 定义之前):

```ts
/**
 * 收口发布策略 (finalize spec)。
 * off=不做; commit=只本地提交; commit_push=提交并推 loop/ 分支; full_pr=提交+推+建 PR(默认)。
 */
export const FinalizePolicy = {
  off: "off",
  commit: "commit",
  commit_push: "commit_push",
  full_pr: "full_pr",
} as const;
export const FinalizePolicySchema = z.enum(["off", "commit", "commit_push", "full_pr"]);
export type FinalizePolicy = z.infer<typeof FinalizePolicySchema>;
```

在 `RunStateSchema` 的对象字段里(`config` 之后、`aborted_at` 之前)加:

```ts
    finalize_policy: FinalizePolicySchema.nullish().default("full_pr"),
    finalize_pr_draft: z.boolean().nullish().default(true),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx bun@1.3.14 test tests-ts/ssot/schema_run_state.test.ts`
Expected: PASS。再跑 `npx tsc --noEmit` 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/ssot-ts/src/schema/run_state.ts tests-ts/ssot/schema_run_state.test.ts
git commit -m "feat(finalize): run-state 加 finalize_policy/finalize_pr_draft 字段

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: finalize/policy.ts — requiredChannels

**Files:**
- Create: `packages/ssot-ts/src/finalize/policy.ts`
- Test: `tests-ts/ssot/finalize_policy.test.ts`

**Interfaces:**
- Consumes: `FinalizePolicy`(Task 1)。
- Produces: `RequiredChannels{needsCommit,needsPush,needsPr}`、`requiredChannels(policy)`。

- [ ] **Step 1: 写失败测试** — `tests-ts/ssot/finalize_policy.test.ts`

```ts
import { test, expect, describe } from "bun:test";
import { requiredChannels } from "../../packages/ssot-ts/src/finalize/policy.js";

describe("requiredChannels", () => {
  test("off → 全 false", () => {
    expect(requiredChannels("off")).toEqual({ needsCommit: false, needsPush: false, needsPr: false });
  });
  test("commit → 仅 commit", () => {
    expect(requiredChannels("commit")).toEqual({ needsCommit: true, needsPush: false, needsPr: false });
  });
  test("commit_push → commit+push", () => {
    expect(requiredChannels("commit_push")).toEqual({ needsCommit: true, needsPush: true, needsPr: false });
  });
  test("full_pr → 全 true", () => {
    expect(requiredChannels("full_pr")).toEqual({ needsCommit: true, needsPush: true, needsPr: true });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx bun@1.3.14 test tests-ts/ssot/finalize_policy.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现** — `packages/ssot-ts/src/finalize/policy.ts`

```ts
/**
 * finalize 档位 → 所需对外通道映射 (finalize spec §关键决策)。纯函数。
 */
import type { FinalizePolicy } from "../schema/run_state.js";

export interface RequiredChannels {
  readonly needsCommit: boolean;
  readonly needsPush: boolean;
  readonly needsPr: boolean;
}

export function requiredChannels(policy: FinalizePolicy): RequiredChannels {
  switch (policy) {
    case "off":
      return { needsCommit: false, needsPush: false, needsPr: false };
    case "commit":
      return { needsCommit: true, needsPush: false, needsPr: false };
    case "commit_push":
      return { needsCommit: true, needsPush: true, needsPr: false };
    case "full_pr":
      return { needsCommit: true, needsPush: true, needsPr: true };
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx bun@1.3.14 test tests-ts/ssot/finalize_policy.test.ts` → PASS;`npx tsc --noEmit` → 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/ssot-ts/src/finalize/policy.ts tests-ts/ssot/finalize_policy.test.ts
git commit -m "feat(finalize): policy.ts requiredChannels 档位→通道映射

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: finalize/channel.ts — probeFinalizeChannel

**Files:**
- Create: `packages/ssot-ts/src/finalize/channel.ts`
- Test: `tests-ts/ssot/finalize_channel.test.ts`

**Interfaces:**
- Produces: `PrBackend = "github" | "none"`;`FinalizeChannel{has_remote, pr_backend, gh_ready}`;`ChannelProbeSeams{remoteUrl, ghAuth}`;`isGithubRemote(url)`;`probeFinalizeChannel(workdir, seams?)`。

- [ ] **Step 1: 写失败测试** — `tests-ts/ssot/finalize_channel.test.ts`

```ts
import { test, expect, describe } from "bun:test";
import {
  probeFinalizeChannel,
  isGithubRemote,
} from "../../packages/ssot-ts/src/finalize/channel.js";

describe("isGithubRemote", () => {
  test("github.com → true", () => {
    expect(isGithubRemote("git@github.com:o/r.git")).toBe(true);
  });
  test("gitlab 自托管 → false", () => {
    expect(isGithubRemote("git@gitlab.corp.com:o/r.git")).toBe(false);
  });
  test("null → false", () => {
    expect(isGithubRemote(null)).toBe(false);
  });
});

describe("probeFinalizeChannel", () => {
  test("github + gh 已认证 → backend github", () => {
    const ch = probeFinalizeChannel("/wd", {
      remoteUrl: () => "https://github.com/o/r.git",
      ghAuth: () => true,
    });
    expect(ch).toEqual({ has_remote: true, pr_backend: "github", gh_ready: true });
  });
  test("gitlab → backend none(通用降级)", () => {
    const ch = probeFinalizeChannel("/wd", {
      remoteUrl: () => "https://gitlab.corp.com/o/r.git",
      ghAuth: () => false,
    });
    expect(ch).toEqual({ has_remote: true, pr_backend: "none", gh_ready: false });
  });
  test("无 remote → has_remote false", () => {
    const ch = probeFinalizeChannel("/wd", { remoteUrl: () => null, ghAuth: () => false });
    expect(ch.has_remote).toBe(false);
    expect(ch.pr_backend).toBe("none");
  });
  test("github 但 gh 未认证 → backend none", () => {
    const ch = probeFinalizeChannel("/wd", {
      remoteUrl: () => "https://github.com/o/r.git",
      ghAuth: () => false,
    });
    expect(ch.pr_backend).toBe("none");
    expect(ch.gh_ready).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — Run: `npx bun@1.3.14 test tests-ts/ssot/finalize_channel.test.ts` → FAIL(模块不存在)。

- [ ] **Step 3: 实现** — `packages/ssot-ts/src/finalize/channel.ts`

```ts
/**
 * 对外发布通道探测 (finalize spec)。
 * 逐级探测 remote 存在 / 是否 GitHub / gh 是否就绪; 异常吞掉返回保守值。seam 可注入便于测试。
 */
import { execFileSync } from "node:child_process";

export type PrBackend = "github" | "none";

export interface FinalizeChannel {
  readonly has_remote: boolean;
  readonly pr_backend: PrBackend;
  readonly gh_ready: boolean;
}

export interface ChannelProbeSeams {
  readonly remoteUrl: (workdir: string) => string | null;
  readonly ghAuth: (workdir: string) => boolean;
}

/** url host 是否 GitHub(github.com 或 GH_HOST 指定的 Enterprise 域名)。 */
export function isGithubRemote(url: string | null): boolean {
  if (!url) return false;
  if (url.includes("github.com")) return true;
  const ghHost = process.env.GH_HOST;
  if (ghHost && ghHost.length > 0 && url.includes(ghHost)) return true;
  return false;
}

function defaultRemoteUrl(workdir: string): string | null {
  try {
    const out = execFileSync("git", ["-C", workdir, "remote", "get-url", "origin"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const t = (out || "").trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

function defaultGhAuth(workdir: string): boolean {
  try {
    execFileSync("gh", ["auth", "status"], {
      cwd: workdir,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return true;
  } catch {
    return false;
  }
}

export function probeFinalizeChannel(
  workdir: string,
  seams: ChannelProbeSeams = { remoteUrl: defaultRemoteUrl, ghAuth: defaultGhAuth },
): FinalizeChannel {
  const url = seams.remoteUrl(workdir);
  const hasRemote = url !== null;
  const github = isGithubRemote(url);
  const ghReady = github && seams.ghAuth(workdir);
  return {
    has_remote: hasRemote,
    pr_backend: github && ghReady ? "github" : "none",
    gh_ready: ghReady,
  };
}
```

- [ ] **Step 4: 跑测试确认通过** — `npx bun@1.3.14 test tests-ts/ssot/finalize_channel.test.ts` → PASS;`npx tsc --noEmit` → 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/ssot-ts/src/finalize/channel.ts tests-ts/ssot/finalize_channel.test.ts
git commit -m "feat(finalize): channel.ts 发布通道探测(github/none 自适应)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: finalize/push_url.ts — extractCreateUrl

**Files:**
- Create: `packages/ssot-ts/src/finalize/push_url.ts`
- Test: `tests-ts/ssot/finalize_push_url.test.ts`

**Interfaces:**
- Produces: `extractCreateUrl(pushStderr: string): string | null`。

- [ ] **Step 1: 写失败测试** — `tests-ts/ssot/finalize_push_url.test.ts`

```ts
import { test, expect, describe } from "bun:test";
import { extractCreateUrl } from "../../packages/ssot-ts/src/finalize/push_url.js";

describe("extractCreateUrl", () => {
  test("GitLab push stderr → merge_requests 链接", () => {
    const stderr = [
      "remote: ",
      "remote: To create a merge request for loop/x, visit:",
      "remote:   https://gitlab.corp.com/g/p/-/merge_requests/new?merge_request%5Bsource_branch%5D=loop/x",
      "remote: ",
    ].join("\n");
    expect(extractCreateUrl(stderr)).toBe(
      "https://gitlab.corp.com/g/p/-/merge_requests/new?merge_request%5Bsource_branch%5D=loop/x",
    );
  });
  test("GitHub push stderr → pull/new 链接", () => {
    const stderr = [
      "remote: Create a pull request for 'loop/x' on GitHub by visiting:",
      "remote:   https://github.com/o/r/pull/new/loop/x",
    ].join("\n");
    expect(extractCreateUrl(stderr)).toBe("https://github.com/o/r/pull/new/loop/x");
  });
  test("无可识别 URL → null", () => {
    expect(extractCreateUrl("Everything up-to-date")).toBeNull();
    expect(extractCreateUrl("")).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `npx bun@1.3.14 test tests-ts/ssot/finalize_push_url.test.ts` → FAIL。

- [ ] **Step 3: 实现** — `packages/ssot-ts/src/finalize/push_url.ts`

```ts
/**
 * 从 git push 的 stderr 提取平台返回的"建 MR/PR"链接 (finalize spec 通用降级)。
 * 平台无关: GitLab merge_requests / GitHub pull/new / 其它 remote: 行里的 http(s) URL。
 * 抓不到返回 null, 由调用方按 remote URL 拼 compare 兜底。纯函数。
 */
export function extractCreateUrl(pushStderr: string): string | null {
  if (!pushStderr) return null;
  const urlRe = /(https?:\/\/[^\s]+)/;
  const prefer = /(merge_request|merge-requests|pull\/new|\/-\/merge_requests)/i;
  let fallback: string | null = null;
  for (const line of pushStderr.split(/\r?\n/)) {
    const m = line.match(urlRe);
    if (!m) continue;
    const url = m[1].replace(/[.,)]+$/, "");
    if (prefer.test(url)) return url;
    if (fallback === null && /remote:/i.test(line)) fallback = url;
  }
  return fallback;
}
```

- [ ] **Step 4: 跑测试确认通过** — `npx bun@1.3.14 test tests-ts/ssot/finalize_push_url.test.ts` → PASS;`npx tsc --noEmit` → 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/ssot-ts/src/finalize/push_url.ts tests-ts/ssot/finalize_push_url.test.ts
git commit -m "feat(finalize): push_url.ts 从 push stderr 抓建 MR/PR 链接

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: finalize/plan.ts — planFinalize(核心决策)

**Files:**
- Create: `packages/ssot-ts/src/finalize/plan.ts`
- Test: `tests-ts/ssot/finalize_plan.test.ts`

**Interfaces:**
- Consumes: `FinalizePolicy`(Task 1)、`FinalizeChannel`/`PrBackend`(Task 3)、`WorktreeBindingMode`(`worktree/binding.ts`,已存在)。
- Produces: `PrAction = "none"|"auto_create"|"link_only"`;`FinalizePlanInput`、`FinalizePlan`、`planFinalize(input)`。

- [ ] **Step 1: 写失败测试** — `tests-ts/ssot/finalize_plan.test.ts`

```ts
import { test, expect, describe } from "bun:test";
import { planFinalize } from "../../packages/ssot-ts/src/finalize/plan.js";
import type { FinalizePlanInput } from "../../packages/ssot-ts/src/finalize/plan.js";
import type { FinalizeChannel } from "../../packages/ssot-ts/src/finalize/channel.js";

const GH: FinalizeChannel = { has_remote: true, pr_backend: "github", gh_ready: true };
const GL: FinalizeChannel = { has_remote: true, pr_backend: "none", gh_ready: false };
const NOREMOTE: FinalizeChannel = { has_remote: false, pr_backend: "none", gh_ready: false };

function base(over: Partial<FinalizePlanInput>): FinalizePlanInput {
  return {
    policy: "full_pr",
    prDraft: true,
    bindingMode: "created",
    bindingBranch: "loop/20260629-001-x",
    bindingBaseRef: "master",
    currentBranch: "loop/20260629-001-x",
    runId: "20260629-001",
    slug: "x",
    channel: GH,
    hasChanges: true,
    authoritative: true,
    ...over,
  };
}

describe("planFinalize", () => {
  test("created + github + 可信 → auto_create, 不新建分支", () => {
    const p = planFinalize(base({}));
    expect(p.do_commit).toBe(true);
    expect(p.need_create_branch).toBe(false);
    expect(p.head_branch).toBe("loop/20260629-001-x");
    expect(p.base_ref).toBe("master");
    expect(p.do_push).toBe(true);
    expect(p.pr_action).toBe("auto_create");
    expect(p.pr_backend).toBe("github");
    expect(p.downgrade_reason).toBeNull();
  });

  test("none 模式 + gitlab → link_only(正常终点, 不算退化), 新建分支", () => {
    const p = planFinalize(base({
      bindingMode: "none", bindingBranch: null, bindingBaseRef: null,
      currentBranch: "develop", channel: GL,
    }));
    expect(p.need_create_branch).toBe(true);
    expect(p.head_branch).toBe("loop/20260629-001-x");
    expect(p.base_ref).toBe("develop");
    expect(p.do_push).toBe(true);
    expect(p.pr_action).toBe("link_only");
    expect(p.downgrade_reason).toBeNull();
  });

  test("actual_writes 不可信 → 禁 push/PR, 仅 commit + 退化原因", () => {
    const p = planFinalize(base({ authoritative: false }));
    expect(p.do_commit).toBe(true);
    expect(p.do_push).toBe(false);
    expect(p.pr_action).toBe("none");
    expect(p.downgrade_reason).toContain("不可信");
  });

  test("无 remote → 仅 commit + 退化", () => {
    const p = planFinalize(base({ channel: NOREMOTE }));
    expect(p.do_push).toBe(false);
    expect(p.pr_action).toBe("none");
    expect(p.downgrade_reason).toContain("remote");
  });

  test("commit_push → link_only(不主动建 PR)", () => {
    const p = planFinalize(base({ policy: "commit_push", channel: GH }));
    expect(p.do_push).toBe(true);
    expect(p.pr_action).toBe("link_only");
  });

  test("off → 全部 false", () => {
    const p = planFinalize(base({ policy: "off" }));
    expect(p.do_commit).toBe(false);
    expect(p.do_push).toBe(false);
    expect(p.pr_action).toBe("none");
  });

  test("无改动 → 不 commit", () => {
    const p = planFinalize(base({ hasChanges: false }));
    expect(p.do_commit).toBe(false);
    expect(p.do_push).toBe(false);
  });

  test("created 但 base 解析不出(detached) → 跳过 PR + 退化", () => {
    const p = planFinalize(base({ bindingBaseRef: "HEAD" }));
    expect(p.base_ref).toBeNull();
    expect(p.pr_action).toBe("none");
    expect(p.downgrade_reason).toContain("base");
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `npx bun@1.3.14 test tests-ts/ssot/finalize_plan.test.ts` → FAIL。

- [ ] **Step 3: 实现** — `packages/ssot-ts/src/finalize/plan.ts`

```ts
/**
 * finalize 决策纯函数 (finalize spec §SSOT plan.ts)。
 * 统一 loop/ 分支 + 自适应 pr_backend + 逐级退化的全部决策都在此, 无副作用。
 */
import type { FinalizePolicy } from "../schema/run_state.js";
import type { FinalizeChannel, PrBackend } from "./channel.js";
import type { WorktreeBindingMode } from "../worktree/binding.js";

export type PrAction = "none" | "auto_create" | "link_only";

export interface FinalizePlanInput {
  readonly policy: FinalizePolicy;
  readonly prDraft: boolean;
  /** binding.mode; 无 binding(纯主仓库工作区)为 null。 */
  readonly bindingMode: WorktreeBindingMode | null;
  readonly bindingBranch: string | null;
  readonly bindingBaseRef: string | null;
  /** 当前 HEAD 符号分支名; detached 为 null。 */
  readonly currentBranch: string | null;
  readonly runId: string;
  readonly slug: string;
  readonly channel: FinalizeChannel;
  /** commit 并集是否非空。 */
  readonly hasChanges: boolean;
  /** commit 并集是否 authoritative(git/fs 采集); worker 自报 → false。 */
  readonly authoritative: boolean;
}

export interface FinalizePlan {
  readonly do_commit: boolean;
  readonly need_create_branch: boolean;
  readonly head_branch: string | null;
  readonly base_ref: string | null;
  readonly do_push: boolean;
  readonly pr_action: PrAction;
  readonly pr_backend: PrBackend;
  readonly pr_draft: boolean;
  readonly downgraded_from: FinalizePolicy | null;
  readonly downgrade_reason: string | null;
}

const NOOP: Omit<FinalizePlan, "head_branch" | "base_ref" | "pr_draft"> = {
  do_commit: false,
  need_create_branch: false,
  do_push: false,
  pr_action: "none",
  pr_backend: "none",
  downgraded_from: null,
  downgrade_reason: null,
};

export function planFinalize(input: FinalizePlanInput): FinalizePlan {
  const headBranch = input.bindingBranch ?? `loop/${input.runId}-${input.slug}`;

  // off / 无改动 → 短路(不视为退化)。
  if (input.policy === "off" || !input.hasChanges) {
    return { ...NOOP, head_branch: headBranch, base_ref: null, pr_draft: input.prDraft };
  }

  // 退化累积器。
  let downgradedFrom: FinalizePolicy | null = null;
  let downgradeReason: string | null = null;
  const downgrade = (reason: string): void => {
    if (downgradedFrom === null) downgradedFrom = input.policy;
    downgradeReason = downgradeReason ? `${downgradeReason}; ${reason}` : reason;
  };

  // base 解析: created 用 binding.base_ref(应已是符号名); 其它用当前分支。
  let baseRef: string | null;
  if (input.bindingMode === "created" || input.bindingMode === "adopted") {
    baseRef =
      input.bindingBaseRef && input.bindingBaseRef !== "HEAD" ? input.bindingBaseRef : null;
  } else {
    baseRef = input.currentBranch;
  }

  // created 模式 worktree 已 checkout 到 loop/ 分支; 其它且当前不在该分支 → 需新建。
  const needCreate = input.bindingMode !== "created" && input.currentBranch !== headBranch;

  // commit 总要(hasChanges)。
  const doCommit = true;

  // push 资格: 档位需要 + authoritative + 有 remote。
  const wantsPush = input.policy === "commit_push" || input.policy === "full_pr";
  let doPush = false;
  if (wantsPush) {
    if (!input.authoritative) {
      downgrade("actual_writes 不可信(worker 自报),禁止自动 push/PR");
    } else if (!input.channel.has_remote) {
      downgrade("无 remote,无法 push");
    } else {
      doPush = true;
    }
  }

  // PR 决策。
  let prAction: PrAction = "none";
  let prBackend: PrBackend = "none";
  if (doPush) {
    if (baseRef === null) {
      downgrade("base 分支解析不出(detached/HEAD),跳过建 PR");
    } else if (
      input.policy === "full_pr" &&
      input.channel.pr_backend === "github" &&
      input.channel.gh_ready
    ) {
      prAction = "auto_create";
      prBackend = "github";
    } else {
      // full_pr 非 GitHub / gh 未就绪, 或 commit_push → 给链接(正常终点, 不退化)。
      prAction = "link_only";
      prBackend = "none";
    }
  }

  return {
    do_commit: doCommit,
    need_create_branch: needCreate,
    head_branch: headBranch,
    base_ref: baseRef,
    do_push: doPush,
    pr_action: prAction,
    pr_backend: prBackend,
    pr_draft: input.prDraft,
    downgraded_from: downgradedFrom,
    downgrade_reason: downgradeReason,
  };
}
```

- [ ] **Step 4: 跑测试确认通过** — `npx bun@1.3.14 test tests-ts/ssot/finalize_plan.test.ts` → PASS;`npx tsc --noEmit` → 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/ssot-ts/src/finalize/plan.ts tests-ts/ssot/finalize_plan.test.ts
git commit -m "feat(finalize): plan.ts planFinalize 核心决策(loop分支+退化+自适应)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: finalize/message.ts — commit/PR 文案

**Files:**
- Create: `packages/ssot-ts/src/finalize/message.ts`
- Test: `tests-ts/ssot/finalize_message.test.ts`

**Interfaces:**
- Produces: `FinalizeRunMeta{runId, title}`;`buildCommitMessage(keyDiffsMd, meta)`、`buildPrBody(keyDiffsMd, meta)`。

- [ ] **Step 1: 写失败测试** — `tests-ts/ssot/finalize_message.test.ts`

```ts
import { test, expect, describe } from "bun:test";
import { buildCommitMessage, buildPrBody } from "../../packages/ssot-ts/src/finalize/message.js";

const META = { runId: "20260629-001", title: "加登录" };

describe("buildCommitMessage", () => {
  test("含 run_id、key-diffs、Co-Authored-By", () => {
    const msg = buildCommitMessage("- src/a.ts: 新增登录", META);
    expect(msg).toContain("20260629-001");
    expect(msg).toContain("src/a.ts");
    expect(msg).toContain("Co-Authored-By:");
  });
});

describe("buildPrBody", () => {
  test("含软约束声明头 + key-diffs", () => {
    const body = buildPrBody("- src/a.ts: 新增登录", META);
    expect(body).toContain("自报");
    expect(body).toContain("src/a.ts");
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `npx bun@1.3.14 test tests-ts/ssot/finalize_message.test.ts` → FAIL。

- [ ] **Step 3: 实现** — `packages/ssot-ts/src/finalize/message.ts`

```ts
/**
 * finalize 的 commit message / PR 正文拼装 (finalize spec §message.ts)。纯函数。
 * PR 正文头部固定声明: 内容来自 worker 自报 key-diffs(软约束), draft, 待人复核。
 */
export interface FinalizeRunMeta {
  readonly runId: string;
  /** 需求标题(取 requirement.md 首行); 缺省可传 run_id。 */
  readonly title: string;
}

const COAUTHOR = "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>";

export function buildCommitMessage(keyDiffsMd: string, meta: FinalizeRunMeta): string {
  const subject = `loop(${meta.runId}): ${meta.title || "自动收口提交"}`;
  const kd = keyDiffsMd.trim();
  const body = kd.length > 0 ? `\n\n${kd}` : "";
  return `${subject}${body}\n\n${COAUTHOR}\n`;
}

export function buildPrBody(keyDiffsMd: string, meta: FinalizeRunMeta): string {
  const header =
    "> ⚠️ 本 PR 由 Loop Engineering 自动收口生成(draft)。以下改动清单来自 worker 自报 " +
    "key-diffs(软约束),**待人复核后再转正式 / 合并**。\n\n";
  const kd = keyDiffsMd.trim();
  const body = kd.length > 0 ? kd : "(无 key-diffs 内容)";
  return `${header}## 改动清单(run ${meta.runId})\n\n${body}\n`;
}
```

- [ ] **Step 4: 跑测试确认通过** — `npx bun@1.3.14 test tests-ts/ssot/finalize_message.test.ts` → PASS;`npx tsc --noEmit` → 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/ssot-ts/src/finalize/message.ts tests-ts/ssot/finalize_message.test.ts
git commit -m "feat(finalize): message.ts commit/PR 文案(含软约束声明)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: finalize/result.ts — FinalizeResult schema + 读写

**Files:**
- Create: `packages/ssot-ts/src/finalize/result.ts`
- Test: `tests-ts/ssot/finalize_result.test.ts`

**Interfaces:**
- Consumes: `atomicReplace`(`runtime/directory.ts`,已导出)。
- Produces: `FINALIZE_RESULT_SCHEMA`、`FinalizeResultSchema`、`FinalizeResult`、`finalizeResultPath(runDir)`、`writeFinalizeResult(runDir, result)`、`readFinalizeResultOrNull(runDir)`。

- [ ] **Step 1: 写失败测试** — `tests-ts/ssot/finalize_result.test.ts`

```ts
import { test, expect, describe } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  writeFinalizeResult,
  readFinalizeResultOrNull,
  FinalizeResultSchema,
} from "../../packages/ssot-ts/src/finalize/result.js";
import type { FinalizeResult } from "../../packages/ssot-ts/src/finalize/result.js";

function mkResult(over: Partial<FinalizeResult> = {}): FinalizeResult {
  return FinalizeResultSchema.parse({
    schema: "loop-engineering.finalize-result.v1",
    policy: "full_pr",
    achieved: "full_pr",
    head_branch: "loop/x",
    base_ref: "master",
    commit_sha: "abc123",
    pushed: true,
    pr_url: "https://github.com/o/r/pull/1",
    pr_draft: true,
    pr_backend: "github",
    create_url: null,
    finalized: true,
    downgrade_reason: null,
    errors: [],
    ...over,
  });
}

describe("FinalizeResult 读写", () => {
  test("write → read 往返一致", () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-"));
    writeFinalizeResult(runDir, mkResult());
    const back = readFinalizeResultOrNull(runDir);
    expect(back?.pr_url).toBe("https://github.com/o/r/pull/1");
    expect(back?.achieved).toBe("full_pr");
  });
  test("不存在 → null", () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-"));
    expect(readFinalizeResultOrNull(runDir)).toBeNull();
  });
  test("非法 achieved 被 schema 拒绝", () => {
    expect(() => mkResult({ achieved: "merged" as never })).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `npx bun@1.3.14 test tests-ts/ssot/finalize_result.test.ts` → FAIL。

- [ ] **Step 3: 实现** — `packages/ssot-ts/src/finalize/result.ts`

```ts
/**
 * finalize 结果 artifact: wrap-up/finalize-result.json (finalize spec §result schema)。
 * 原子写复用 runtime/directory 的 atomicReplace(Windows 文件锁重试)。
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { z } from "zod";
import { atomicReplace } from "../runtime/directory.js";

export const FINALIZE_RESULT_SCHEMA = "loop-engineering.finalize-result.v1";

export const FinalizeResultSchema = z.object({
  schema: z.literal(FINALIZE_RESULT_SCHEMA),
  policy: z.enum(["off", "commit", "commit_push", "full_pr"]),
  achieved: z.enum(["off", "no_changes", "commit", "commit_push", "full_pr"]),
  head_branch: z.string().nullable(),
  base_ref: z.string().nullable(),
  commit_sha: z.string().nullable(),
  pushed: z.boolean(),
  pr_url: z.string().nullable(),
  pr_draft: z.boolean(),
  pr_backend: z.enum(["github", "none"]),
  create_url: z.string().nullable(),
  finalized: z.boolean(),
  downgrade_reason: z.string().nullable(),
  errors: z.array(z.string()),
});
export type FinalizeResult = z.infer<typeof FinalizeResultSchema>;

export function finalizeResultPath(runDir: string): string {
  return path.join(runDir, "wrap-up", "finalize-result.json");
}

export function writeFinalizeResult(runDir: string, result: FinalizeResult): void {
  const validated = FinalizeResultSchema.parse(result);
  const target = finalizeResultPath(runDir);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.finalize-result-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, "utf-8");
    atomicReplace(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function readFinalizeResultOrNull(runDir: string): FinalizeResult | null {
  const p = finalizeResultPath(runDir);
  if (!fs.existsSync(p)) return null;
  try {
    return FinalizeResultSchema.parse(JSON.parse(fs.readFileSync(p, "utf-8")));
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 跑测试确认通过** — `npx bun@1.3.14 test tests-ts/ssot/finalize_result.test.ts` → PASS;`npx tsc --noEmit` → 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/ssot-ts/src/finalize/result.ts tests-ts/ssot/finalize_result.test.ts
git commit -m "feat(finalize): result.ts finalize-result.json schema 与读写

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: finalize/index.ts + package.json exports

**Files:**
- Create: `packages/ssot-ts/src/finalize/index.ts`
- Modify: `packages/ssot-ts/package.json`
- Test: `tests-ts/ssot/finalize_index.test.ts`

**Interfaces:**
- Produces: `@e2e-loop/ssot/finalize` 子路径导出(给 CLI 引用)。

- [ ] **Step 1: 写失败测试** — `tests-ts/ssot/finalize_index.test.ts`

```ts
import { test, expect } from "bun:test";
import {
  requiredChannels,
  probeFinalizeChannel,
  isGithubRemote,
  extractCreateUrl,
  planFinalize,
  buildCommitMessage,
  buildPrBody,
  FinalizeResultSchema,
  writeFinalizeResult,
} from "../../packages/ssot-ts/src/finalize/index.js";

test("finalize barrel 导出齐全", () => {
  for (const fn of [
    requiredChannels, probeFinalizeChannel, isGithubRemote, extractCreateUrl,
    planFinalize, buildCommitMessage, buildPrBody, writeFinalizeResult,
  ]) {
    expect(typeof fn).toBe("function");
  }
  expect(FinalizeResultSchema).toBeDefined();
});
```

- [ ] **Step 2: 跑测试确认失败** — `npx bun@1.3.14 test tests-ts/ssot/finalize_index.test.ts` → FAIL(index 不存在)。

- [ ] **Step 3: 实现** — `packages/ssot-ts/src/finalize/index.ts`

```ts
/** finalize 子包 barrel 导出 (finalize spec)。 */
export * from "./policy.js";
export * from "./channel.js";
export * from "./push_url.js";
export * from "./plan.js";
export * from "./message.js";
export * from "./result.js";
```

在 `packages/ssot-ts/package.json` 的 `exports` 里,`"./dispatch"` 块之后、`"./package.json"` 之前插入:

```json
    "./finalize": {
      "types": "./dist/finalize/index.d.ts",
      "import": "./dist/finalize/index.js",
      "default": "./dist/finalize/index.js"
    },
```

- [ ] **Step 4: 跑测试 + 构建确认通过**

Run: `npx bun@1.3.14 test tests-ts/ssot/finalize_index.test.ts` → PASS
Run: `npm run build` → 成功(确认 `packages/ssot-ts/dist/finalize/index.js` 生成)
Run: `npx tsc --noEmit` → 通过

- [ ] **Step 5: Commit**

```bash
git add packages/ssot-ts/src/finalize/index.ts packages/ssot-ts/package.json tests-ts/ssot/finalize_index.test.ts
git commit -m "feat(finalize): index barrel + package.json exports ./finalize

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: allocator — base 解析符号分支名

**Files:**
- Modify: `packages/ssot-ts/src/worktree/allocator.ts`
- Test: `tests-ts/ssot/worktree_allocator.test.ts`

**Interfaces:**
- Produces: created 模式 binding 的 `base_ref` 为符号分支名(如 `master`),不再是字面 `HEAD`。

- [ ] **Step 1: 写失败测试** — 追加到 `tests-ts/ssot/worktree_allocator.test.ts`

```ts
import { allocateRunWorktree } from "../../packages/ssot-ts/src/worktree/allocator.js";

test("created 模式 base_ref 解析为符号分支名", () => {
  const calls: string[][] = [];
  const fakeGit = (args: readonly string[], _cwd: string): string => {
    calls.push([...args]);
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/repo";
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main";
    if (args[0] === "worktree" && args[1] === "add") return "";
    return "";
  };
  const alloc = allocateRunWorktree({
    mode: "always",
    repoCwd: "/repo",
    runId: "20260629-001",
    worktreePath: "/tmp/wt-finalize-base",
    baseRef: "HEAD",
    requirementSlug: "demo",
    git: fakeGit,
    now: new Date("2026-06-29T00:00:00Z"),
  });
  expect(alloc.binding?.base_ref).toBe("main");
});
```

(注:`mode: "always"` 走 `allocateCreated`;`worktreePath` 指定一个不存在路径;`.gitignore` 校验对 `/tmp` 外部路径自动放行,见 `assertWorktreeRootIgnored` 的相对路径判断。若该测试环境对 worktreePath 有 existsSync 干扰,改用 `mode: "always"` + 唯一临时路径。)

- [ ] **Step 2: 跑测试确认失败** — `npx bun@1.3.14 test tests-ts/ssot/worktree_allocator.test.ts` → 新 case FAIL(当前 base_ref="HEAD")。

- [ ] **Step 3: 实现** — 在 `allocator.ts` 加 helper 并改 `allocateCreated`

在 `repoRootFor` 函数之后加:

```ts
/** 解析 baseRef 的符号分支名; detached HEAD / 失败返回 null(供 PR base 用)。 */
function resolveSymbolicBase(cwd: string, git: GitRunner, baseRef: string): string | null {
  try {
    const out = gitOutput(git, cwd, ["rev-parse", "--abbrev-ref", baseRef]);
    if (!out || out === "HEAD") return null;
    return out;
  } catch {
    return null;
  }
}
```

在 `allocateCreated` 内,`git(["worktree", "add", ...])` **之前**解析,并把解析结果传给 binding:

```ts
  const branch = `${branchPrefix}${opts.runId}-${slugify(opts.requirementSlug)}`;
  // PR base 需符号分支名: 在 worktree add(切走 HEAD)之前, 从 repoRoot 解析 baseRef 的符号名。
  const symbolicBase = resolveSymbolicBase(repoRoot, git, baseRef) ?? baseRef;
  git(["worktree", "add", worktreePath, "-b", branch, baseRef], repoRoot);
  syncProjectHookConfig(repoRoot, worktreePath);

  const binding = makeBinding({
    mode: "created",
    repoRoot,
    worktreePath,
    branch,
    baseRef: symbolicBase,
    managed: true,
    now: opts.now ?? new Date(),
  });
```

- [ ] **Step 4: 跑测试确认通过** — `npx bun@1.3.14 test tests-ts/ssot/worktree_allocator.test.ts` → 全 PASS;`npx tsc --noEmit` → 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/ssot-ts/src/worktree/allocator.ts tests-ts/ssot/worktree_allocator.test.ts
git commit -m "feat(finalize): allocator created 模式记录符号 base 分支名(供 PR base)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: CLI — init 写 finalize_policy

**Files:**
- Modify: `packages/cli/src/args.ts`(加选项)
- Modify: `packages/cli/src/commands/dryrun.ts`(`runInit`)
- Test: `tests-ts/finalize_init.test.ts`

**Interfaces:**
- Consumes: `FinalizePolicy` 字面量集合。
- Produces: `e2e-loop init ... --finalize <off|commit|commit_push|full_pr> [--no-pr-draft]` 把 `finalize_policy` / `finalize_pr_draft` 写进 run-state.json。

- [ ] **Step 1: 写失败测试** — `tests-ts/finalize_init.test.ts`

```ts
import { test, expect, describe } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runInit } from "../packages/cli/src/commands/dryrun.js";
import type { Args } from "../packages/cli/src/args.js";

function mkArgs(positional: string[], values: Record<string, string | undefined>, flags: string[] = []): Args {
  return { command: "init", values, flags: new Set(flags), positional, acList: [] };
}

function readState(runsRoot: string, runId: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(runsRoot, runId, "run-state.json"), "utf-8"));
}

describe("init --finalize", () => {
  test("缺省 → full_pr + draft", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fi-"));
    const req = path.join(root, "req.md");
    fs.writeFileSync(req, "# 需求\n做个登录\n");
    const code = runInit(mkArgs([req], { "runs-root": path.join(root, "runs"), "worktree-mode": "none" }));
    expect(code).toBe(0);
    const runs = path.join(root, "runs");
    const runId = fs.readdirSync(runs)[0]!;
    const s = readState(runs, runId);
    expect(s.finalize_policy).toBe("full_pr");
    expect(s.finalize_pr_draft).toBe(true);
  });

  test("--finalize commit_push --no-pr-draft", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fi-"));
    const req = path.join(root, "req.md");
    fs.writeFileSync(req, "# 需求\n做个登录\n");
    const code = runInit(mkArgs([req],
      { "runs-root": path.join(root, "runs"), "worktree-mode": "none", finalize: "commit_push" },
      ["no-pr-draft"]));
    expect(code).toBe(0);
    const runs = path.join(root, "runs");
    const runId = fs.readdirSync(runs)[0]!;
    const s = readState(runs, runId);
    expect(s.finalize_policy).toBe("commit_push");
    expect(s.finalize_pr_draft).toBe(false);
  });

  test("非法 --finalize → 退出码 2", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fi-"));
    const req = path.join(root, "req.md");
    fs.writeFileSync(req, "x");
    const code = runInit(mkArgs([req],
      { "runs-root": path.join(root, "runs"), "worktree-mode": "none", finalize: "merge" }));
    expect(code).toBe(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `npx bun@1.3.14 test tests-ts/finalize_init.test.ts` → FAIL(finalize_policy 未写入 / 非法值未拦)。

- [ ] **Step 3a: 实现 args** — `packages/cli/src/args.ts`,在 `options` 对象里(`task` 之后)加:

```ts
    // --- finalize 子命令 / init 的收尾策略 ---
    finalize: { type: "string" as const },
    "no-pr-draft": { type: "boolean" as const },
```

- [ ] **Step 3b: 实现 runInit** — `packages/cli/src/commands/dryrun.ts`,在 `runInit` 内 `const requirementText = ...` 之后加校验,并在 `stateInput` 里写字段

校验(放在 `worktreeMode` 校验之后):

```ts
  const FINALIZE_POLICIES = ["off", "commit", "commit_push", "full_pr"] as const;
  const rawFinalize = args.values.finalize;
  if (rawFinalize !== undefined && !FINALIZE_POLICIES.includes(rawFinalize as never)) {
    process.stderr.write("错误: --finalize 必须是 off|commit|commit_push|full_pr\n");
    return 2;
  }
  const finalizePolicy = rawFinalize ?? "full_pr";
  const finalizePrDraft = !args.flags.has("no-pr-draft");
```

在 `const stateInput: Record<string, unknown> = { run_id, complexity, phase };` 之后加:

```ts
  stateInput.finalize_policy = finalizePolicy;
  stateInput.finalize_pr_draft = finalizePrDraft;
```

并在末尾输出补一行(`process.stdout.write("phase: ...")` 之后):

```ts
  process.stdout.write("finalize: " + finalizePolicy + (finalizePrDraft ? " (draft)" : "") + "\n");
```

- [ ] **Step 4: 跑测试确认通过** — `npx bun@1.3.14 test tests-ts/finalize_init.test.ts` → PASS;`npx tsc --noEmit` → 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/args.ts packages/cli/src/commands/dryrun.ts tests-ts/finalize_init.test.ts
git commit -m "feat(finalize): init --finalize/--no-pr-draft 写入 run-state

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: CLI — finalize 子命令编排 + 注册

**Files:**
- Create: `packages/cli/src/commands/finalize.ts`
- Modify: `packages/cli/src/index.ts`(注册)
- Test: `tests-ts/finalize_cli.test.ts`

**Interfaces:**
- Consumes: `@e2e-loop/ssot/finalize`(planFinalize/probeFinalizeChannel/extractCreateUrl/build*/writeFinalizeResult)、`@e2e-loop/ssot/runtime`(readRunState/readTaskPlan/readActualWrites)、`@e2e-loop/ssot/worktree`(readWorktreeBindingOrNull)、`@e2e-loop/ssot/schema`(Phase/TaskStatus)。
- Produces: `runFinalize(args)`、可测核心 `runFinalizeImpl(args, deps)`、类型 `FinalizeRunner`/`FinalizeGitResult`/`FinalizeDeps`。

- [ ] **Step 1: 写失败测试** — `tests-ts/finalize_cli.test.ts`(用 fixture + 注入 fake runner)

```ts
import { test, expect, describe } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runFinalizeImpl } from "../packages/cli/src/commands/finalize.js";
import type { FinalizeDeps, FinalizeGitResult } from "../packages/cli/src/commands/finalize.js";
import type { Args } from "../packages/cli/src/args.js";

/** 造一个最小 COMPLETE run: run-state + binding + plan + 一个 complete task 的 actual-writes。 */
function mkRun(opts: { policy: string; bindingMode: "created" | "none"; authoritative: boolean }): { runsRoot: string; runId: string; runDir: string } {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fcli-"));
  const runId = "20260629-001";
  const runDir = path.join(runsRoot, runId);
  for (const d of ["input", "planning", "tasks", "wrap-up", "tasks/t1"]) {
    fs.mkdirSync(path.join(runDir, d), { recursive: true });
  }
  fs.writeFileSync(path.join(runDir, "input", "requirement.md"), "# 加登录\n");
  const state: Record<string, unknown> = {
    run_id: runId, complexity: "simple", phase: "COMPLETE",
    finalize_policy: opts.policy, finalize_pr_draft: true,
    workdir: runDir,
  };
  fs.writeFileSync(path.join(runDir, "run-state.json"), JSON.stringify(state, null, 2));
  if (opts.bindingMode === "created") {
    fs.writeFileSync(path.join(runDir, "worktree-binding.json"), JSON.stringify({
      schema: "loop-engineering.worktree-binding.v1", mode: "created", owner: "loop-engineering",
      repo_root: runDir, worktree_path: runDir, branch: "loop/20260629-001-x",
      base_ref: "master", created_at: "2026-06-29T00:00:00Z", managed: true, status: "active",
    }, null, 2));
  }
  fs.writeFileSync(path.join(runDir, "planning", "task-plan.yaml"),
    "complexity: simple\ntasks:\n  - id: t1\n    title: t1\n    allowed_write_paths: ['src/**']\n    acceptance_refs: ['AC-1']\n    status: complete\n");
  fs.writeFileSync(path.join(runDir, "tasks", "t1", "actual-writes.json"), JSON.stringify({
    source: opts.authoritative ? "git" : "self_report",
    is_authoritative: opts.authoritative, writes: ["src/login.ts"],
  }, null, 2));
  return { runsRoot, runId, runDir };
}

function mkArgs(runId: string, runsRoot: string, flags: string[] = []): Args {
  return { command: "finalize", values: { "runs-root": runsRoot }, flags: new Set(flags), positional: [runId], acList: [] };
}

/** 录制型 fake runner: 按命令前缀返回桩结果, 记录调用序列。 */
function recordingDeps(over: {
  remoteUrl?: string | null; ghAuth?: number; pushStderr?: string; ghStdout?: string;
  currentBranch?: string;
}): { deps: FinalizeDeps; calls: string[][] } {
  const calls: string[][] = [];
  const git = (a: readonly string[], _cwd: string): FinalizeGitResult => {
    calls.push(["git", ...a]);
    const j = a.join(" ");
    if (j.includes("remote get-url")) return { stdout: over.remoteUrl ?? "", stderr: "", status: over.remoteUrl ? 0 : 1 };
    if (j.includes("rev-parse --abbrev-ref HEAD")) return { stdout: over.currentBranch ?? "master", stderr: "", status: 0 };
    if (j.includes("rev-parse HEAD")) return { stdout: "deadbeef", stderr: "", status: 0 };
    if (j.startsWith("-C") && j.includes("status --porcelain")) return { stdout: "", stderr: "", status: 0 };
    if (a[0] === "push") return { stdout: "", stderr: over.pushStderr ?? "", status: 0 };
    return { stdout: "", stderr: "", status: 0 };
  };
  const gh = (a: readonly string[], _cwd: string): FinalizeGitResult => {
    calls.push(["gh", ...a]);
    if (a[0] === "auth") return { stdout: "", stderr: "", status: over.ghAuth ?? 1 };
    if (a[0] === "pr" && a[1] === "create") return { stdout: over.ghStdout ?? "https://github.com/o/r/pull/1\n", stderr: "", status: 0 };
    return { stdout: "", stderr: "", status: 0 };
  };
  return { deps: { git, gh }, calls };
}

describe("runFinalizeImpl", () => {
  test("github happy path → auto_create draft PR", () => {
    const { runsRoot, runId, runDir } = mkRun({ policy: "full_pr", bindingMode: "created", authoritative: true });
    const { deps, calls } = recordingDeps({
      remoteUrl: "https://github.com/o/r.git", ghAuth: 0, currentBranch: "loop/20260629-001-x",
      ghStdout: "https://github.com/o/r/pull/1\n",
    });
    const code = runFinalizeImpl(mkArgs(runId, runsRoot), deps);
    expect(code).toBe(0);
    const res = JSON.parse(fs.readFileSync(path.join(runDir, "wrap-up", "finalize-result.json"), "utf-8"));
    expect(res.achieved).toBe("full_pr");
    expect(res.pr_url).toBe("https://github.com/o/r/pull/1");
    expect(res.pr_draft).toBe(true);
    expect(calls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create")).toBe(true);
    expect(calls.some((c) => c.join(" ").includes("--draft"))).toBe(true);
  });

  test("内部仓库(gitlab) → link_only, create_url 来自 push stderr, 不调 gh pr create", () => {
    const { runsRoot, runId, runDir } = mkRun({ policy: "full_pr", bindingMode: "created", authoritative: true });
    const { deps, calls } = recordingDeps({
      remoteUrl: "https://gitlab.corp.com/g/p.git", ghAuth: 1, currentBranch: "loop/20260629-001-x",
      pushStderr: "remote:   https://gitlab.corp.com/g/p/-/merge_requests/new?x=loop/20260629-001-x\n",
    });
    const code = runFinalizeImpl(mkArgs(runId, runsRoot), deps);
    expect(code).toBe(0);
    const res = JSON.parse(fs.readFileSync(path.join(runDir, "wrap-up", "finalize-result.json"), "utf-8"));
    expect(res.achieved).toBe("commit_push");
    expect(res.pr_url).toBeNull();
    expect(res.create_url).toContain("merge_requests/new");
    expect(calls.some((c) => c[0] === "gh" && c[1] === "pr")).toBe(false);
  });

  test("actual_writes 不可信 → 只 commit, 不 push", () => {
    const { runsRoot, runId, runDir } = mkRun({ policy: "full_pr", bindingMode: "created", authoritative: false });
    const { deps, calls } = recordingDeps({ remoteUrl: "https://github.com/o/r.git", ghAuth: 0, currentBranch: "loop/20260629-001-x" });
    const code = runFinalizeImpl(mkArgs(runId, runsRoot), deps);
    expect(code).toBe(0);
    const res = JSON.parse(fs.readFileSync(path.join(runDir, "wrap-up", "finalize-result.json"), "utf-8"));
    expect(res.achieved).toBe("commit");
    expect(res.pushed).toBe(false);
    expect(res.downgrade_reason).toContain("不可信");
    expect(calls.some((c) => c[0] === "git" && c[1] === "push")).toBe(false);
  });

  test("policy=off → 直接写 off 结果, 无 git 调用", () => {
    const { runsRoot, runId, runDir } = mkRun({ policy: "off", bindingMode: "created", authoritative: true });
    const { deps, calls } = recordingDeps({ remoteUrl: "https://github.com/o/r.git", ghAuth: 0 });
    const code = runFinalizeImpl(mkArgs(runId, runsRoot), deps);
    expect(code).toBe(0);
    const res = JSON.parse(fs.readFileSync(path.join(runDir, "wrap-up", "finalize-result.json"), "utf-8"));
    expect(res.achieved).toBe("off");
    expect(calls.length).toBe(0);
  });

  test("--dry-run 不产生副作用(不 commit/push)", () => {
    const { runsRoot, runId } = mkRun({ policy: "full_pr", bindingMode: "created", authoritative: true });
    const { deps, calls } = recordingDeps({ remoteUrl: "https://github.com/o/r.git", ghAuth: 0, currentBranch: "loop/20260629-001-x" });
    const code = runFinalizeImpl(mkArgs(runId, runsRoot, ["dry-run"]), deps);
    expect(code).toBe(0);
    expect(calls.some((c) => c[0] === "git" && (c[1] === "commit" || c[1] === "push"))).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `npx bun@1.3.14 test tests-ts/finalize_cli.test.ts` → FAIL(模块不存在)。

- [ ] **Step 3: 实现** — `packages/cli/src/commands/finalize.ts`

```ts
/**
 * e2e-loop finalize <run_id>: run 收口后的发布编排(finalize spec §CLI)。
 *
 * 唯一有副作用处: 按 planFinalize 的计划实跑 git/gh。git/gh 经 deps 注入(测试可注入 fake),
 * 默认实现用 spawnSync + GIT_TERMINAL_PROMPT=0(非交互, 缺凭证不挂起)。
 * finalize 不写 run-state(单写者是 Coordinator), 只写 wrap-up/finalize-result.json。
 */
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  planFinalize,
  probeFinalizeChannel,
  extractCreateUrl,
  buildCommitMessage,
  buildPrBody,
  writeFinalizeResult,
  type FinalizePlan,
  type FinalizeResult,
} from "@e2e-loop/ssot/finalize";
import { readRunState, readTaskPlan, readActualWrites } from "@e2e-loop/ssot/runtime";
import { readWorktreeBindingOrNull } from "@e2e-loop/ssot/worktree";
import { Phase, TaskStatus } from "@e2e-loop/ssot/schema";

import type { Args } from "../args.js";

export interface FinalizeGitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}
export type FinalizeRunner = (args: readonly string[], cwd: string) => FinalizeGitResult;
export interface FinalizeDeps {
  readonly git: FinalizeRunner;
  readonly gh: FinalizeRunner;
}

function spawnRunner(bin: string): FinalizeRunner {
  return (a, cwd) => {
    const r = cp.spawnSync(bin, [...a], {
      cwd,
      encoding: "utf-8",
      timeout: 120_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
  };
}
const defaultDeps: FinalizeDeps = { git: spawnRunner("git"), gh: spawnRunner("gh") };

function resolveRunsRoot(args: Args): string {
  const raw = args.values["runs-root"];
  return path.resolve(raw && raw.length > 0 ? raw : "runs");
}

/** 从 requirement.md 首个非空行取标题(去掉前导 #)。 */
function deriveTitle(runDir: string): string {
  try {
    const text = fs.readFileSync(path.join(runDir, "input", "requirement.md"), "utf-8");
    for (const line of text.split(/\r?\n/)) {
      const t = line.replace(/^#+\s*/, "").trim();
      if (t.length > 0) return t.slice(0, 60);
    }
  } catch {
    /* ignore */
  }
  return "";
}

function slugify(raw: string): string {
  const s = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return s || "run";
}

/** 汇总各 complete task 的 actual-writes 并集 + authoritative 标志。 */
function collectChangeSet(runDir: string, taskIds: string[]): { paths: string[]; authoritative: boolean } {
  const set = new Set<string>();
  let authoritative = taskIds.length > 0;
  for (const tid of taskIds) {
    const aw = readActualWrites(runDir, tid);
    if (aw === null) {
      authoritative = false; // 缺采集结果 → 不可信
      continue;
    }
    if (!aw.is_authoritative) authoritative = false;
    for (const p of aw.writes) set.add(p);
  }
  return { paths: [...set].sort(), authoritative };
}

export function runFinalize(args: Args): number {
  return runFinalizeImpl(args, defaultDeps);
}

export function runFinalizeImpl(args: Args, deps: FinalizeDeps): number {
  const runId = args.positional[0];
  if (!runId) {
    process.stderr.write("错误: finalize 需要位置参数 <run_id>\n");
    return 2;
  }
  const runsRoot = resolveRunsRoot(args);
  const runDir = path.join(runsRoot, runId);

  let state;
  try {
    state = readRunState(runDir);
  } catch {
    process.stderr.write(`错误: run-state.json 不存在: ${runDir}\n`);
    return 2;
  }
  if (state.phase !== Phase.COMPLETE) {
    process.stderr.write(`错误: 当前 phase=${state.phase}, 必须 COMPLETE 才能 finalize\n`);
    return 2;
  }

  const policy = state.finalize_policy ?? "full_pr";
  const prDraft = state.finalize_pr_draft ?? true;

  const binding = readWorktreeBindingOrNull(runDir);
  const workdir = state.workdir ?? binding?.worktree_path ?? path.dirname(runDir);

  // policy=off → 直接写 off 结果, 不碰 git。
  if (policy === "off") {
    return writeResultAndReport(runDir, mkOffResult());
  }

  // 汇总 commit 并集。
  let completeTaskIds: string[] = [];
  try {
    const plan = readTaskPlan(path.join(runDir, "planning", "task-plan.yaml"));
    completeTaskIds = plan.tasks.filter((t) => t.status === TaskStatus.complete).map((t) => t.id);
  } catch {
    completeTaskIds = [];
  }
  const change = collectChangeSet(runDir, completeTaskIds);

  // 探测 channel(经 deps, 便于测试)。
  const channel = probeFinalizeChannel(workdir, {
    remoteUrl: (wd) => {
      const r = deps.git(["-C", wd, "remote", "get-url", "origin"], wd);
      const t = r.stdout.trim();
      return r.status === 0 && t.length > 0 ? t : null;
    },
    ghAuth: (wd) => deps.gh(["auth", "status"], wd).status === 0,
  });

  // 当前符号分支。
  const cbr = deps.git(["-C", workdir, "rev-parse", "--abbrev-ref", "HEAD"], workdir);
  const currentBranch = cbr.status === 0 && cbr.stdout.trim() !== "HEAD" ? cbr.stdout.trim() : null;

  const slug = binding?.branch ? binding.branch.replace(/^.*?-/, "").replace(`${runId}-`, "") : slugify(deriveTitle(runDir));
  const plan: FinalizePlan = planFinalize({
    policy, prDraft,
    bindingMode: binding?.mode ?? null,
    bindingBranch: binding?.branch ?? null,
    bindingBaseRef: binding?.base_ref ?? null,
    currentBranch,
    runId,
    slug: binding?.branch ? slug : slugify(deriveTitle(runDir)),
    channel,
    hasChanges: change.paths.length > 0,
    authoritative: change.authoritative,
  });

  // dry-run: 打印计划, 不执行副作用。
  if (args.flags.has("dry-run")) {
    process.stdout.write(`${JSON.stringify({ run_id: runId, plan, change_paths: change.paths }, null, 2)}\n`);
    return 0;
  }

  return executePlan(runDir, workdir, runId, plan, change.paths, policy, prDraft, deps, args.flags.has("force"));
}

function mkOffResult(): FinalizeResult {
  return {
    schema: "loop-engineering.finalize-result.v1", policy: "off", achieved: "off",
    head_branch: null, base_ref: null, commit_sha: null, pushed: false, pr_url: null,
    pr_draft: false, pr_backend: "none", create_url: null, finalized: true,
    downgrade_reason: null, errors: [],
  };
}

function writeResultAndReport(runDir: string, result: FinalizeResult): number {
  writeFinalizeResult(runDir, result);
  const tip = result.pr_url ?? result.create_url ?? `achieved=${result.achieved}`;
  process.stdout.write(`finalize: ${result.achieved} | ${tip}\n`);
  return 0;
}

function executePlan(
  runDir: string, workdir: string, runId: string, plan: FinalizePlan,
  changePaths: string[], policy: FinalizeResult["policy"], prDraft: boolean,
  deps: FinalizeDeps, force: boolean,
): number {
  const errors: string[] = [];
  let achieved: FinalizeResult["achieved"] = "no_changes";
  let commitSha: string | null = null;
  let pushed = false;
  let prUrl: string | null = null;
  let createUrl: string | null = null;

  if (!plan.do_commit) {
    // off 已在前面处理; 这里是 no_changes。
    return writeResultAndReport(runDir, {
      schema: "loop-engineering.finalize-result.v1", policy, achieved: "no_changes",
      head_branch: plan.head_branch, base_ref: plan.base_ref, commit_sha: null, pushed: false,
      pr_url: null, pr_draft: prDraft, pr_backend: plan.pr_backend, create_url: null,
      finalized: true, downgrade_reason: plan.downgrade_reason, errors,
    });
  }

  // none/existing 模式 dirty 守卫: 工作区有并集外未提交改动且无 --force → 拒绝。
  if (plan.need_create_branch && !force) {
    const st = deps.git(["-C", workdir, "status", "--porcelain"], workdir);
    const dirtyOutside = st.stdout.split(/\r?\n/)
      .map((l) => l.slice(3).trim())
      .filter((p) => p.length > 0 && !changePaths.includes(p));
    if (dirtyOutside.length > 0) {
      process.stderr.write(
        `错误: 工作区存在 ${dirtyOutside.length} 个非本 run 改动(${dirtyOutside.slice(0, 3).join(", ")}…)。` +
          `加 --force 仅提交本 run 文件, 或先清理工作区。\n`,
      );
      return 2;
    }
  }

  // 切/建分支。
  if (plan.need_create_branch && plan.head_branch) {
    const sw = deps.git(["switch", "-c", plan.head_branch], workdir);
    if (sw.status !== 0) deps.git(["switch", plan.head_branch], workdir); // 已存在 → 直接切
  }

  // commit 并集。
  deps.git(["add", "--", ...changePaths], workdir);
  const title = deriveTitle(runDir);
  const keyDiffsMd = readKeyDiffsAggregate(runDir);
  const msg = buildCommitMessage(keyDiffsMd, { runId, title });
  const tmpMsg = path.join(os.tmpdir(), `loop-commit-${runId}-${Date.now()}.txt`);
  fs.writeFileSync(tmpMsg, msg, "utf-8");
  const ci = deps.git(["commit", "-F", tmpMsg], workdir);
  try { fs.unlinkSync(tmpMsg); } catch { /* ignore */ }
  if (ci.status === 0) {
    const sha = deps.git(["-C", workdir, "rev-parse", "HEAD"], workdir);
    commitSha = sha.status === 0 ? sha.stdout.trim() : null;
    achieved = "commit";
  } else if (/nothing to commit/i.test(ci.stdout + ci.stderr)) {
    achieved = "commit"; // 已提交过(幂等)
    const sha = deps.git(["-C", workdir, "rev-parse", "HEAD"], workdir);
    commitSha = sha.status === 0 ? sha.stdout.trim() : null;
  } else {
    errors.push(`commit 失败: ${ci.stderr.trim() || ci.stdout.trim()}`);
  }

  // push。
  if (plan.do_push && plan.head_branch && errors.length === 0) {
    const ph = deps.git(["push", "-u", "origin", plan.head_branch], workdir);
    if (ph.status === 0) {
      pushed = true;
      achieved = "commit_push";
      createUrl = extractCreateUrl(ph.stderr);
    } else {
      errors.push(`push 失败: ${ph.stderr.trim()}`);
    }
  }

  // PR。
  if (plan.pr_action === "auto_create" && pushed && plan.base_ref && plan.head_branch) {
    const body = buildPrBody(readKeyDiffsAggregate(runDir), { runId, title });
    const tmpBody = path.join(os.tmpdir(), `loop-prbody-${runId}-${Date.now()}.md`);
    fs.writeFileSync(tmpBody, body, "utf-8");
    const ghArgs = ["pr", "create", "--base", plan.base_ref, "--head", plan.head_branch,
      "--title", `loop(${runId}): ${title || "自动收口"}`, "--body-file", tmpBody];
    if (prDraft) ghArgs.push("--draft");
    const pr = deps.gh(ghArgs, workdir);
    try { fs.unlinkSync(tmpBody); } catch { /* ignore */ }
    const urlLine = pr.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => /^https?:\/\//.test(l));
    if (pr.status === 0 && urlLine) {
      prUrl = urlLine;
      achieved = "full_pr";
    } else {
      errors.push(`gh pr create 失败: ${pr.stderr.trim() || pr.stdout.trim()}`);
    }
  }

  const result: FinalizeResult = {
    schema: "loop-engineering.finalize-result.v1", policy,
    achieved, head_branch: plan.head_branch, base_ref: plan.base_ref,
    commit_sha: commitSha, pushed, pr_url: prUrl, pr_draft: prDraft,
    pr_backend: plan.pr_backend, create_url: createUrl, finalized: errors.length === 0,
    downgrade_reason: plan.downgrade_reason, errors,
  };
  writeResultAndReport(runDir, result);
  return errors.length === 0 ? 0 : 1;
}

/** 汇总各 task 的 key-diffs.yaml 文本(简单拼接; 缺失跳过)。 */
function readKeyDiffsAggregate(runDir: string): string {
  const tasksDir = path.join(runDir, "tasks");
  if (!fs.existsSync(tasksDir)) return "";
  const parts: string[] = [];
  for (const ent of fs.readdirSync(tasksDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const kd = path.join(tasksDir, ent.name, "key-diffs.yaml");
    if (fs.existsSync(kd)) parts.push(`### ${ent.name}\n${fs.readFileSync(kd, "utf-8").trim()}`);
  }
  return parts.join("\n\n");
}
```

注册: `packages/cli/src/index.ts` —— import 处加 `import { runFinalize } from "./commands/finalize.js";`,在 switch 的 `collect-outcome` case 之后加:

```ts
    case "finalize":
      return dryRunGuard(() => runFinalize(args));
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx bun@1.3.14 test tests-ts/finalize_cli.test.ts` → PASS(5 个 case 全绿)
Run: `npx tsc --noEmit` → 通过
Run: `npm run build` → 成功

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/finalize.ts packages/cli/src/index.ts tests-ts/finalize_cli.test.ts
git commit -m "feat(finalize): e2e-loop finalize 子命令编排 + 注册(github/通用降级/dry-run)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 12: 提示词触发 + changlog + 全量验证

**Files:**
- Modify: `core/coordinator.md`
- Modify: `docs/loop-engineering-master-prompt.md`
- Modify: `changlog.md`

**Interfaces:** 无代码接口;让主 agent 在进入 COMPLETE 后按 `finalize_policy` 调 `e2e-loop finalize`。

- [ ] **Step 1: coordinator.md 收口段加 finalize 触发**

在 `core/coordinator.md` 的收口/COMPLETE 相关段落后补一段(若无明显锚点,加在文件"收口"小节末尾):

```markdown
### 收口后发布(finalize, 可选)

run 进入 COMPLETE 后,若 run-state.finalize_policy != off:
1. 跑 `node packages/cli/dist/index.js finalize <run_id>`(高复杂度/risk 先 `--dry-run` 回显给人确认提交清单与 head→base)。
2. 读 `wrap-up/finalize-result.json` 的 `achieved` / `pr_url` / `create_url`,把结果摘要回报给人:
   - `full_pr` → 给出 draft PR URL;
   - `commit_push` + `create_url` → 内部仓库正常终点,给出"建 MR"链接让人点;
   - `commit` / `downgrade_reason` 非空 → 说明退化原因 + 人接手方式;
   - `errors` 非空 → 如实报告失败,**绝不谎报已建 PR**。
3. finalize 成功(`finalized=true`)后才允许 worktree cleanup。
CREATED 开场时确认本 run 的收尾策略(默认 full_pr + draft),写入 run-state。
```

- [ ] **Step 2: master-prompt 同步一句** — 在 `docs/loop-engineering-master-prompt.md` 收口段落补一句等价说明(双宿主调同一 CLI):

```markdown
- 收口进 COMPLETE 后, 若 finalize_policy != off, 跑 `e2e-loop finalize <run_id>`, 把 finalize-result.json 的 PR URL 或建 MR 链接(或退化原因)回报给人; finalize 成功才允许 worktree cleanup。
```

- [ ] **Step 3: changlog.md 加条目** — 在最新版本块下加:

```markdown
- feat(finalize): 新增 run 收口自动 commit/push/PR 能力。init `--finalize <off|commit|commit_push|full_pr>`(默认 full_pr+draft);新增 SSOT `finalize/` 子包(policy/channel/push_url/plan/message/result)与 CLI `e2e-loop finalize` 子命令;GitHub 自动建 draft PR,内部仓库(GitLab/Gitea 等)通用降级为 commit+push+输出建 MR 链接;commit 仅取 actual_writes 并集,actual_writes 不可信时禁 push/PR;非交互(GIT_TERMINAL_PROMPT=0)防挂起。spec: docs/superpowers/specs/2026-06-29-auto-finalize-commit-push-pr-design.md。
```

- [ ] **Step 4: 全量验证**

```bash
npx tsc --noEmit
npm run build
npx bun@1.3.14 test tests-ts/
```
Expected: 类型检查通过、构建成功、全部测试绿。

- [ ] **Step 5: Commit**

```bash
git add core/coordinator.md docs/loop-engineering-master-prompt.md changlog.md
git commit -m "feat(finalize): 提示词层收口触发 finalize + changlog 条目

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- finalize_policy 四档 + init 选 + 默认 full_pr → Task 1/10 ✓
- 默认 draft PR → Task 6(声明)/11(`--draft`)✓
- SSOT finalize 子包(policy/channel/push_url/plan/message/result/index)→ Task 2–8 ✓
- commit 用 actual_writes 并集、不用 git add -A → Task 11 `collectChangeSet` + `git add -- <paths>` ✓
- actual_writes 不可信守卫 → Task 5(plan)+ Task 11(collectChangeSet)✓
- 统一 loop/ 分支、永不推当前分支、none 模式新建 → Task 5/11 ✓
- base 解析符号名 → Task 9(allocator)+ Task 5(detached 退化)✓
- pr_backend 自适应 github/none + 通用降级抓 stderr → Task 3/4/5/11 ✓
- 非交互 GIT_TERMINAL_PROMPT=0 → Task 3/11 ✓
- none 模式 dirty 守卫 + --force → Task 11 ✓
- finalize-result.json + finalized 前置 → Task 7/11/12 ✓
- 不改状态机 / 不改 binding schema → 全程未触碰 transitions.ts / binding schema ✓
- 双宿主提示词触发 → Task 12 ✓
- 退化矩阵(no_changes/commit/commit_push/full_pr)→ Task 11 achieved 流转 ✓
- 幂等(nothing to commit / 分支已存在 switch)→ Task 11 ✓

**Type consistency:** `FinalizePlan` 字段(plan.ts)被 Task 11 executePlan 消费,字段名一致(do_commit/need_create_branch/head_branch/base_ref/do_push/pr_action/pr_backend/pr_draft/downgrade_reason);`FinalizeResult` 字段(result.ts)被 Task 11 写入,字段名一致;`FinalizeChannel{has_remote,pr_backend,gh_ready}` 跨 Task 3/5/11 一致;`FinalizeRunner`/`FinalizeGitResult` 在 Task 11 内自洽。

**残留风险(已在 spec 风险节记录):** none 模式 WIP 交叠;PR 描述源自软约束(draft + 声明 + 人复核缓解);建 MR 链接依赖 push stderr 格式(`extractCreateUrl` 正则,新平台需补)。
