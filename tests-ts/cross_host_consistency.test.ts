/**
 * 跨宿主一致性 e2e 测试 (设计 §13.3)。
 *
 * 证明 Claude Code 与 OpenCode 两宿主在同源 core 与同一 shared logic 下**行为一致**:
 *
 *   (a) 共享资产一致: 两 adapter 各自 install 后, 落的
 *       .claude/skills/loop-engineering/SKILL.md 与 standards/*.md **字节级一致**
 *       (同源 core/coordinator.md + core/standards/*, §6.1)。
 *
 *   (b) hook 决策一致 (核心): 对同一逻辑场景 (IMPLEMENTING + 写受保护路径 vs 写 allowed 源码),
 *       分别经 CC binding 输入形状 (直接调 shared.handleGuardPaths) 与 OC plugin 输入形状
 *       (LoopEngineeringPlugin 的 tool.execute.before), 断言:
 *         CC 的 deny  ⟺ OC 的 throw (拦截)
 *         CC 的 allow ⟺ OC 不 throw (放行)
 *       这证明同一 shared logic 在两宿主 binding 下决策一致。
 *
 * 隔离策略: 每个场景独立 os.tmpdir() repoRoot, run 建在 repoRoot/runs/。
 *   CC 侧 findActiveRun(cwd=repoRoot) 与 OC 侧 findActiveRun(directory=repoRoot) 都尊重
 *   LOOP_RUNS_ROOT; 为让两侧扫到**完全同一个 run**, 每个 (b) 场景把 LOOP_RUNS_ROOT 设为
 *   该 repoRoot/runs (afterEach 还原)。(a) 不依赖 run, 不设 env。
 */

import { test, expect, afterEach, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { claudeCodeAdapter } from "@e2e-loop/adapter-claude-code";
import { opencodeAdapter } from "@e2e-loop/adapter-opencode";
import { handleGuardPaths } from "@e2e-loop/shared";
import type { HookInput } from "@e2e-loop/shared";
import { LoopEngineeringPlugin } from "../packages/adapter-oc/src/plugin/index.js";
import type {
  OcPluginHooks,
  OcToolBeforeOutput,
  OcToolInputMeta,
} from "../packages/adapter-oc/src/plugin/runtime.js";

// ---------------------------------------------------------------------------
// 公共夹具
// ---------------------------------------------------------------------------

const _toClean: string[] = [];
const _envBackup = process.env.LOOP_RUNS_ROOT;

function tmpRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `xhost-${label}-`));
  _toClean.push(root);
  return root;
}

afterEach(() => {
  // 还原 LOOP_RUNS_ROOT (b 组每个场景会改它)
  if (_envBackup === undefined) delete process.env.LOOP_RUNS_ROOT;
  else process.env.LOOP_RUNS_ROOT = _envBackup;
});

afterAll(() => {
  while (_toClean.length) {
    const d = _toClean.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 文件锁等清理失败不影响结论 */
    }
  }
});

// ===========================================================================
// (a) 共享资产一致: 两 adapter install 后 SKILL.md + standards/*.md 字节级一致
// ===========================================================================

const SKILL_REL = path.join(
  ".claude",
  "skills",
  "loop-engineering",
  "SKILL.md",
);
const STANDARDS_REL = path.join(
  ".claude",
  "skills",
  "loop-engineering",
  "standards",
);

test("(a) 共享资产: CC 与 OC install 落的 SKILL.md 字节级一致", async () => {
  const ccDir = tmpRoot("a-cc");
  const ocDir = tmpRoot("a-oc");

  await claudeCodeAdapter.install({ projectDir: ccDir, force: true });
  await opencodeAdapter.install({ projectDir: ocDir, force: true });

  const ccSkill = fs.readFileSync(path.join(ccDir, SKILL_REL));
  const ocSkill = fs.readFileSync(path.join(ocDir, SKILL_REL));

  // 都来自 core/coordinator.md 纯复制 → 字节级一致
  expect(ccSkill.equals(ocSkill)).toBe(true);
  // 非空 (确认真的落了内容, 不是两个空文件相等)
  expect(ccSkill.byteLength).toBeGreaterThan(0);
});

test("(a) 共享资产: CC 与 OC install 落的 standards/*.md 同名同字节", async () => {
  const ccDir = tmpRoot("a2-cc");
  const ocDir = tmpRoot("a2-oc");

  await claudeCodeAdapter.install({ projectDir: ccDir, force: true });
  await opencodeAdapter.install({ projectDir: ocDir, force: true });

  const ccStdDir = path.join(ccDir, STANDARDS_REL);
  const ocStdDir = path.join(ocDir, STANDARDS_REL);

  const ccFiles = fs.readdirSync(ccStdDir).filter((f) => f.endsWith(".md")).sort();
  const ocFiles = fs.readdirSync(ocStdDir).filter((f) => f.endsWith(".md")).sort();

  // 文件名集合一致
  expect(ocFiles).toEqual(ccFiles);
  // standards 真实存在 (core/standards 非空)
  expect(ccFiles.length).toBeGreaterThan(0);

  // 逐文件字节级一致
  for (const f of ccFiles) {
    const cc = fs.readFileSync(path.join(ccStdDir, f));
    const oc = fs.readFileSync(path.join(ocStdDir, f));
    expect(oc.equals(cc)).toBe(true);
  }
});

// ===========================================================================
// (b) hook 决策一致: 同一场景经 CC binding 与 OC binding 得相同拦截/放行
// ===========================================================================

/** 单 task t1 (status=running), allowed_write_paths=src/**。 */
const IMPL_PLAN =
  "schema: loop-engineering.task-plan.v2\n" +
  "complexity: simple\n" +
  "tasks:\n" +
  "  - id: t1\n" +
  "    title: impl task\n" +
  "    allowed_write_paths:\n" +
  "      - src/**\n" +
  "    acceptance_refs:\n" +
  "      - AC1\n" +
  "    status: running\n";

/**
 * 在 repoRoot/runs/<runId> 下建一个 IMPLEMENTING 活跃 run (含 task-plan),
 * 并把 LOOP_RUNS_ROOT 设为 repoRoot/runs (CC 与 OC 两侧 findActiveRun 都尊重它)。
 */
function makeImplRun(repoRoot: string, runId: string): void {
  const runsRoot = path.join(repoRoot, "runs");
  const runDir = path.join(runsRoot, runId);
  fs.mkdirSync(path.join(runDir, "planning"), { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "run-state.json"),
    JSON.stringify({
      run_id: runId,
      phase: "IMPLEMENTING",
      complexity: "simple",
      trust_mode: "collaborative",
      active_tasks: ["t1"],
    }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(runDir, "planning", "task-plan.yaml"),
    IMPL_PLAN,
    "utf-8",
  );
  process.env.LOOP_RUNS_ROOT = runsRoot;
}

/** CC binding 形状: 直接调 shared.handleGuardPaths, 返回 decision。 */
async function ccDecision(
  repoRoot: string,
  absFilePath: string,
): Promise<"allow" | "deny" | "defer"> {
  const input: HookInput = {
    event: "PreToolUse",
    toolName: "Write",
    toolInput: { file_path: absFilePath, content: "x" },
    cwd: repoRoot,
  };
  const out = await handleGuardPaths(input);
  return out.decision;
}

/**
 * OC plugin 形状: 经 LoopEngineeringPlugin 的 tool.execute.before(write) 调用。
 * 返回 { threw, msg }: deny → throw (threw=true); allow → 不 throw (threw=false)。
 */
async function ocBefore(
  repoRoot: string,
  absFilePath: string,
): Promise<{ threw: boolean; msg: string }> {
  const hooks: OcPluginHooks = await LoopEngineeringPlugin({
    directory: repoRoot,
  });
  const meta: OcToolInputMeta = { tool: "write" };
  const output: OcToolBeforeOutput = {
    args: { filePath: absFilePath, content: "x" },
  };
  try {
    await hooks["tool.execute.before"]!(meta, output);
    return { threw: false, msg: "" };
  } catch (e) {
    return { threw: true, msg: e instanceof Error ? e.message : String(e) };
  }
}

// --- 场景 1: 写受保护路径 .claude/x → CC deny ⟺ OC throw ---
test("(b) 受保护路径 .claude/x: CC deny ⟺ OC throw (两宿主同拦截)", async () => {
  const protectedRel = path.join(".claude", "x.txt");

  // CC 侧
  const ccRepo = tmpRoot("b1-cc");
  makeImplRun(ccRepo, "20260101-001");
  const ccd = await ccDecision(ccRepo, path.join(ccRepo, protectedRel));

  // OC 侧 (独立 repo, 同逻辑场景)
  const ocRepo = tmpRoot("b1-oc");
  makeImplRun(ocRepo, "20260101-001");
  const ocr = await ocBefore(ocRepo, path.join(ocRepo, protectedRel));

  // 断言: CC deny ⟺ OC throw
  expect(ccd).toBe("deny");
  expect(ocr.threw).toBe(true);
  // 两侧拦截原因同含 ".claude" (同一 shared logic 给的 reason)
  expect(ocr.msg).toContain(".claude");
});

// --- 场景 2: 写 allowed 源码路径 src/foo.ts → CC allow ⟺ OC 不 throw ---
test("(b) allowed 源码 src/foo.ts: CC allow ⟺ OC 不 throw (两宿主同放行)", async () => {
  const allowedRel = path.join("src", "foo.ts");

  // CC 侧
  const ccRepo = tmpRoot("b2-cc");
  makeImplRun(ccRepo, "20260101-001");
  const ccd = await ccDecision(ccRepo, path.join(ccRepo, allowedRel));

  // OC 侧
  const ocRepo = tmpRoot("b2-oc");
  makeImplRun(ocRepo, "20260101-001");
  const ocr = await ocBefore(ocRepo, path.join(ocRepo, allowedRel));

  // 断言: CC allow ⟺ OC 不 throw
  expect(ccd).toBe("allow");
  expect(ocr.threw).toBe(false);
});

// --- 场景 3: 写越界源码 docs/x.md (不在 allowed) → CC deny ⟺ OC throw ---
//     补强 (b): 不只测永久 deny 区, 也测"白名单越界"这条 logic 分支两宿主一致。
test("(b) 越界源码 docs/x.md: CC deny ⟺ OC throw (白名单越界两宿主同拦截)", async () => {
  const oobRel = path.join("docs", "x.md");

  const ccRepo = tmpRoot("b3-cc");
  makeImplRun(ccRepo, "20260101-001");
  const ccd = await ccDecision(ccRepo, path.join(ccRepo, oobRel));

  const ocRepo = tmpRoot("b3-oc");
  makeImplRun(ocRepo, "20260101-001");
  const ocr = await ocBefore(ocRepo, path.join(ocRepo, oobRel));

  expect(ccd).toBe("deny");
  expect(ocr.threw).toBe(true);
  // 同一 logic: 越界拒绝 reason 含 allowed_write_paths
  expect(ocr.msg).toContain("allowed_write_paths");
});
