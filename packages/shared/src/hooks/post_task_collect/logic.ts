/**
 * C. PostToolUse:Task —— 防糊弄的物理保证 (规范源: design §0.2;
 * 行为权威: Python `hooks/loop_engineering/post_task_collect.py`)。
 *
 * 主 agent 通过 Task 工具收回 worker 结果时:
 *   1. 从 subagent_type 判定 worker 类型 (非 loop worker 静默放行)。
 *   2. 验证该 worker 必产出的 artifact 落盘 (§0.4 artifact-first)。
 *   3. implementation-worker: 独立重算 actual_writes (§0.2 防糊弄核心), 覆盖 worker 自报告。
 *   4. verified + actual_writes + warnings 通过 defer.context 注入主 agent 下一轮。
 *
 * block 条件 (artifact 缺失 / schema 不合法 / clarification 既无问题又无 skip_basis):
 *   → decision=deny; reason 含 "artifact" 或 "skip_basis"
 *
 * warning 条件 (worker 自报告与 git diff 不一致 / 采集回退到 self_report):
 *   → 不 block, 在 context.warnings 里标红。
 *
 * sideEffect: actual_writes 重算结果落盘到 `tasks/<id>/actual-writes.json`,
 *              保持 handle 主体"纯函数 + 显式副作用"。
 *
 * 异常 fail-safe = deny (Python `main` 的 except 分支)。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";
import type { HookInput, HookOutput, SideEffect } from "../../types.js";
import {
  classifyWorker,
  deny,
  findActiveTask,
  injectContext,
  passSilent,
  safeReadRunState,
  safeReadTaskPlan,
  WORKER_CLARIFICATION,
  WORKER_IMPLEMENTATION,
  WORKER_PLAN,
  WORKER_RED_TEAM,
  type WorkerName,
} from "../common.js";
import { findActiveRun } from "../../runs.js";
import {
  computeActualWrites,
  extractPathsFromText,
  type ActualWrites,
} from "../../actual_writes.js";

// ---------------------------------------------------------------------------
// 各 worker 必需 artifact 路径
// ---------------------------------------------------------------------------

interface ArtifactMap {
  [key: string]: string;
}

function implArtifacts(runDir: string, taskId: string): ArtifactMap {
  const base = path.join(runDir, "tasks", taskId);
  return {
    test_results: path.join(base, "test-results.yaml"),
    summary: path.join(base, "summary.md"),
    key_diffs: path.join(base, "key-diffs.yaml"),
  };
}

function planArtifacts(runDir: string): ArtifactMap {
  return {
    design: path.join(runDir, "planning", "design.md"),
    task_plan: path.join(runDir, "planning", "task-plan.yaml"),
  };
}

function clarificationArtifacts(runDir: string): ArtifactMap {
  return {
    questions: path.join(runDir, "clarification", "questions.json"),
  };
}

function redTeamArtifacts(runDir: string): ArtifactMap {
  return {
    red_team_review: path.join(runDir, "wrap-up", "red-team-review.md"),
  };
}

// ---------------------------------------------------------------------------
// worker 输出文本提取 (不信任, 用于与 git diff 比对的 warning)
// ---------------------------------------------------------------------------

/** 从 Task tool 的 response 里尽量抽出 worker 输出文本。 */
function extractWorkerText(toolResponse: unknown): string {
  if (typeof toolResponse === "string") return toolResponse;
  if (typeof toolResponse !== "object" || toolResponse === null) {
    return String(toolResponse ?? "");
  }
  const r = toolResponse as Record<string, unknown>;
  for (const key of ["result", "content", "output", "text", "stdout"]) {
    const v = r[key];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  try {
    return JSON.stringify(toolResponse);
  } catch {
    return String(toolResponse);
  }
}

// ---------------------------------------------------------------------------
// test-results.yaml 解析 (机械 tests_green, §0.2 防糊弄)
// ---------------------------------------------------------------------------

interface TestResultsShape {
  tests_green?: boolean;
  [k: string]: unknown;
}

/**
 * 解析 test-results.yaml, 提取机械 tests_green。
 *
 * schema 不合法 (非 yaml / 缺 tests_green / 类型错) → 抛错, 调用方据此 block。
 */
function readTestResultsGreen(p: string): boolean {
  const text = fs.readFileSync(p, "utf-8");
  const data = yaml.load(text) as unknown;
  if (typeof data !== "object" || data === null) {
    throw new Error("test-results.yaml 顶层非 object");
  }
  const tr = data as TestResultsShape;
  if (typeof tr.tests_green !== "boolean") {
    throw new Error("test-results.yaml.tests_green 不是 boolean");
  }
  return tr.tests_green;
}

// ---------------------------------------------------------------------------
// worker 分支处理
// ---------------------------------------------------------------------------

interface HandleResult {
  output: HookOutput;
  /** actual_writes 落盘副作用 (仅 implementation 分支产生); 无则 undefined */
  sideEffectPath?: string;
}

async function handleImplementation(
  input: HookInput,
  runDir: string,
): Promise<HandleResult> {
  const state = safeReadRunState({ ...input, runDir });
  const plan = safeReadTaskPlan(runDir);
  const task = findActiveTask(plan, state);
  if (task === null) {
    return {
      output: deny(
        "implementation-worker 交回但找不到 status=running 的 task; " +
          "无法定位 artifacts (§0.4 artifact-first)",
      ),
    };
  }

  const artifacts = implArtifacts(runDir, task.id);
  const missing = Object.values(artifacts).filter((p) => !fs.existsSync(p));
  if (missing.length > 0) {
    return {
      output: deny(
        `worker ${WORKER_IMPLEMENTATION} 未产出必需 artifact [${missing.join(", ")}]; §0.4 artifact-first`,
      ),
    };
  }

  // 1. 机械求值 tests_green
  let testsGreen: boolean;
  try {
    testsGreen = readTestResultsGreen(artifacts.test_results);
  } catch (e) {
    return {
      output: deny(
        `test-results.yaml schema 不合法: ${e instanceof Error ? e.message : String(e)}; §0.4 artifact-first`,
      ),
    };
  }

  // 2. 重算 actual_writes (§0.2 防糊弄核心)
  // sinceMarker 用 HEAD (capabilities.git_diff=True 时才有意义);
  // computeActualWrites 内部会按 git 可用性降级到 fs / self_report。
  let actual: ActualWrites;
  try {
    actual = await computeActualWrites(runDir, task.id, "HEAD", input.cwd);
  } catch (e) {
    // 重算失败不 block (避免能力缺失锁死), 但 warnings 标红; 用空结果兜底
    const warn = `actual_writes 重算异常: ${e instanceof Error ? e.message : String(e)}`;
    actual = { source: "self_report", paths: [], isAuthoritative: false };
    return {
      output: injectContext(
        {
          verified: true,
          worker: WORKER_IMPLEMENTATION,
          task_id: task.id,
          artifacts,
          tests_green_mechanical: testsGreen,
          tests_green_worker_self_report_stripped: true,
          actual_writes: {
            source: "unavailable",
            is_authoritative: false,
            writes: [],
          },
          warnings: [warn],
        },
      ),
      sideEffectPath: path.join(runDir, "tasks", task.id, "actual-writes.json"),
    };
  }

  // 3. 从 worker 自报告文本里粗抓路径, 与 git diff 比对 (§0.2 防糊弄 warning)
  const workerText = extractWorkerText(input.toolResponse);
  const selfReportPaths = extractPathsFromText(workerText);
  const warnings: string[] = [];
  const gitPaths = new Set(actual.paths);

  const claimedNotInGit = Array.from(selfReportPaths)
    .filter((p) => !gitPaths.has(p))
    .sort();
  if (claimedNotInGit.length > 0 && actual.isAuthoritative) {
    warnings.push(
      `worker 自报告写入但 git diff 未抓到: [${claimedNotInGit.join(", ")}] ` +
        "(可能 worker 自报了但实际未落盘; §0.2 防糊弄)",
    );
  }
  if (actual.source === "self_report") {
    warnings.push(
      "actual_writes 来源=self_report (宿主无 git/fs 能力), " +
        "未做独立采集, 数据不可信; §0.2",
    );
  }

  // 4. 注入主 agent 下一轮 (defer.context)
  return {
    output: injectContext({
      verified: true,
      worker: WORKER_IMPLEMENTATION,
      task_id: task.id,
      artifacts,
      tests_green_mechanical: testsGreen,
      tests_green_worker_self_report_stripped: true,
      actual_writes: {
        source: actual.source,
        is_authoritative: actual.isAuthoritative,
        writes: actual.paths,
      },
      worker_self_report_paths_stripped_if_absent_from_git: true,
      warnings,
    }),
    sideEffectPath: path.join(runDir, "tasks", task.id, "actual-writes.json"),
  };
}

function handlePlan(runDir: string): HandleResult {
  const artifacts = planArtifacts(runDir);
  const missing = Object.values(artifacts).filter((p) => !fs.existsSync(p));
  if (missing.length > 0) {
    return {
      output: deny(
        `worker ${WORKER_PLAN} 未产出必需 artifact [${missing.join(", ")}]; §0.4 artifact-first`,
      ),
    };
  }

  const plan = safeReadTaskPlan(runDir);
  if (plan === null) {
    return {
      output: deny(
        `task-plan.yaml 解析失败; §0.4 artifact-first (路径=${artifacts.task_plan})`,
      ),
    };
  }

  // hook 设计边界: 这里只校验 artifact 落盘 + plan 可解析 (§0.4 artifact-first)。
  // plan_check 的完整机械检查 (path_overlap / acceptance_refs / risk:high key-diffs 等)
  // 由 Coordinator.submitPlan 跑, 结果落 planning/plan-check-failures.json;
  // guard_anchors 在 PLANNING 阶段读该结果文件做 Stop 门禁。
  // 本 hook 不重跑 plan_check (避免循环依赖 + 避免与 Coordinator 双写结果)。
  //
  // 诚实标注 (SKILL §2 信条 5 "诚实高于合规外观"): hook 不跑 plan_check, 就不能注入
  // plan_check_all_pass=true —— 否则主 agent 见字段名会误以为 hook 验证过。改注入
  // plan_check_ran_by + plan_check_failures_path, 明确告诉主 agent 真值来源。
  return {
    output: injectContext({
      verified: true,
      worker: WORKER_PLAN,
      artifacts,
      plan_check_ran_by: "coordinator", // hook 不评判; 真值由 Coordinator.submitPlan 跑出后落 plan-check-failures.json
      plan_check_failures_path: "planning/plan-check-failures.json",
      warnings: [],
      note: "plan_check 由 Coordinator.submitPlan 跑 (非 hook); 失败项见 planning/plan-check-failures.json",
    }),
  };
}

function handleClarification(runDir: string): HandleResult {
  const artifacts = clarificationArtifacts(runDir);
  const missing = Object.values(artifacts).filter((p) => !fs.existsSync(p));
  if (missing.length > 0) {
    return {
      output: deny(
        `worker ${WORKER_CLARIFICATION} 未产出必需 artifact [${missing.join(", ")}]; §0.4 artifact-first`,
      ),
    };
  }

  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(artifacts.questions, "utf-8"));
  } catch (e) {
    return {
      output: deny(
        `questions.json schema 不合法: ${e instanceof Error ? e.message : String(e)}`,
      ),
    };
  }

  // 兼容 {questions: [...]} 与 [...] 两种形态
  const questions = Array.isArray(data)
    ? data
    : (data as { questions?: unknown[] })?.questions;
  const skipBasis = Array.isArray(data)
    ? undefined
    : (data as { skip_basis?: unknown[] })?.skip_basis;
  const questionCount = Array.isArray(questions) ? questions.length : 0;
  const skipBasisCount = Array.isArray(skipBasis) ? skipBasis.length : 0;

  // 防糊弄强制点 (用户决策 2026-06-28): "无需澄清" 不能无证落盘。
  // 合法产出二选一: ① 有 ≥1 问题 (真有阻塞歧义); ② 空问题 + 非空 skip_basis (裁量跳过留证)。
  // 两者皆空 = 既没找到问题又不给跳过依据 = 无证据的糊弄, deny。
  if (questionCount === 0 && skipBasisCount === 0) {
    return {
      output: deny(
        "questions.json 既无 questions 又无 skip_basis; clarification-finder 必须产出 " +
          "≥1 问题, 或在判定无需澄清时给出非空 skip_basis (裁量跳过须留可审计证据)",
      ),
    };
  }

  return {
    output: injectContext({
      verified: true,
      worker: WORKER_CLARIFICATION,
      artifacts,
      question_count: questionCount,
      skip_basis_count: skipBasisCount,
      warnings: [],
    }),
  };
}

function handleRedTeam(runDir: string): HandleResult {
  const artifacts = redTeamArtifacts(runDir);
  const missing = Object.values(artifacts).filter((p) => !fs.existsSync(p));
  if (missing.length > 0) {
    return {
      output: deny(
        `worker ${WORKER_RED_TEAM} 未产出必需 artifact [${missing.join(", ")}]; §0.4 artifact-first`,
      ),
    };
  }
  return {
    output: injectContext({
      verified: true,
      worker: WORKER_RED_TEAM,
      artifacts,
      warnings: [],
    }),
  };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * post_task_collect 主入口 (Python `main` 等价)。
 *
 * 异常 fail-safe = deny (Python main except 分支); 不静默放过 hook 内部错误。
 */
export async function handle(input: HookInput): Promise<HookOutput> {
  try {
    const worker = classifyWorker(input.toolInput);
    if (worker === null) {
      // 非 loop-engineering worker 的 Task 调用: 静默放行 (不干扰其它用法)
      return passSilent();
    }

    const active = findActiveRun(input.cwd);
    if (active === null) {
      return deny(
        `worker ${worker as WorkerName} 交回但找不到活跃 run 目录 (runs/ 下无子目录); ` +
          "§0.4 artifact-first 要求先 init_run_dir",
      );
    }

    const runDir = active.runDir;
    let result: HandleResult;
    switch (worker) {
      case WORKER_IMPLEMENTATION:
        result = await handleImplementation(input, runDir);
        break;
      case WORKER_PLAN:
        result = handlePlan(runDir);
        break;
      case WORKER_CLARIFICATION:
        result = handleClarification(runDir);
        break;
      case WORKER_RED_TEAM:
        result = handleRedTeam(runDir);
        break;
      default: {
        // 穷尽性检查 (WorkerName 是有限联合)
        const _exhaustive: never = worker;
        void _exhaustive;
        return passSilent();
      }
    }

    // actual_writes 显式副作用 (仅 implementation 分支产生)
    if (result.sideEffectPath) {
      const sideEffect: SideEffect = {
        file: result.sideEffectPath,
        content: readSideEffectContent(result, runDir),
      };
      return { ...result.output, sideEffect };
    }
    return result.output;
  } catch (e) {
    return deny(
      `post_task_collect hook 内部错误: ${e instanceof Error ? e.stack ?? e.message : String(e)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 辅助 (handle 实现细节)
// ---------------------------------------------------------------------------

/**
 * 从 handleImplementation 的 result 里抽取 actual_writes 内容用于落盘。
 *
 * 由于 injectContext 把 actual_writes 包在 context 里, 这里反向取; 始终写一个 JSON
 * 文件 `{source, is_authoritative, writes}` (与 Python sideEffect 行为一致)。
 */
function readSideEffectContent(result: HandleResult, _runDir: string): unknown {
  const ctx = result.output.context ?? {};
  const aw = (ctx.actual_writes ?? {
    source: "unavailable",
    is_authoritative: false,
    writes: [],
  }) as { source?: string; is_authoritative?: boolean; writes?: string[] };
  return {
    source: aw.source ?? "unavailable",
    is_authoritative: aw.is_authoritative ?? false,
    writes: aw.writes ?? [],
  };
}

/*
 * 用例预期 (从 Python tests/test_hooks_smoke.py 翻译, T5 落地):
 *
 *   1. subagent_type="implementation-worker" + 三 artifact 齐全 + tests_green=true → defer;
 *      context.tests_green_mechanical=true, sideEffect 落 actual-writes.json
 *   2. subagent_type="implementation-worker" + 缺 summary.md → deny; reason 含 "artifact"
 *   3. subagent_type="implementation-worker" + test-results.yaml.tests_green=false → defer;
 *      context.tests_green_mechanical=false (不 block, 由 coordinator 决定)
 *   4. subagent_type="plan-agent" + design.md + task-plan.yaml 齐全 → defer;
 *      context.verified=true (hook 不评判 plan_check; 真值由 Coordinator.submitPlan 跑)
 *   5. subagent_type="clarification-finder" + questions.json 含 3 问题 → defer;
 *      context.question_count=3
 *   6. subagent_type="clarification-finder" + 空 questions 且空 skip_basis → deny; reason 含 "skip_basis"
 *   6b. subagent_type="clarification-finder" + 空 questions 但非空 skip_basis → defer (裁量跳过留证合法)
 *   7. subagent_type="other-worker" (非 loop) → allow (静默放行)
 *   8. 无活跃 run + loop worker 交回 → deny; reason 含 "init_run_dir"
 *   9. internal error → deny (fail-safe, 不静默放过)
 */
