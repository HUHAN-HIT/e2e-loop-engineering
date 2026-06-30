/**
 * Coordinator clarification 人锚点回退 (2026-06-30) 的单元测试。
 *
 * 行为权威: `packages/ssot-ts/src/runtime/coordinator.ts` 的 submitClarification /
 * answerClarification + `state_machine/human_anchors.ts` (clarification 锚点合法性)。
 *
 * 覆盖 (对应 design §1 主流程 CLARIFYING 段):
 * 1. submitClarification(非空 questions) → set human_pending=clarification, phase 仍 CLARIFYING
 * 2. submitClarification(空 questions + 非空 skip_basis) → human_pending 仍 null (不 set)
 * 3. submitClarification(非空 questions) 在 PLANNING phase 调用 → throw (含 "CLARIFYING phase")
 * 4. answerClarification(在 CLARIFYING + clarification 锚点) → 清锚点 + 推进 PLANNING
 * 5. answerClarification(在 CLARIFYING + 无锚点) → 仍推进 PLANNING (向后兼容)
 *
 * 构造套路: 直接写 phase=CLARIFYING 的 run-state.json (跳过 startClarifying 直接进 PLANNING 的路径),
 * 用 parseClarificationQuestions / parseClarificationAnswers 构造合法对象,
 * 验证 phase 推进读 coord.state.phase, 验证锚点读 coord.state.human_pending。
 */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  Coordinator,
  initRunDir,
  writeRunState,
} from "../../packages/ssot-ts/src/runtime/index.js";
import {
  InlineWorkerRunner,
  makeWorkerOutcome,
} from "../../packages/ssot-ts/src/dispatch/index.js";
import type { WorkerOutcome } from "../../packages/ssot-ts/src/dispatch/index.js";
import { Phase } from "../../packages/ssot-ts/src/schema/run_state.js";
import { parseRunState } from "../../packages/ssot-ts/src/schema/run_state.js";
import {
  parseClarificationAnswers,
  parseClarificationQuestions,
} from "../../packages/ssot-ts/src/schema/clarification.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** 临时 runs 根目录 (用后即清)。 */
function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loop-clar-"));
}

/** 占位 worker callback (本测试不真派发 worker, runner 仅用于构造 Coordinator)。 */
function noopWorker(): WorkerOutcome {
  return makeWorkerOutcome({ status: "completed" });
}

/**
 * 构造一个 phase=CLARIFYING 的 Coordinator (run-state 直接落 CLARIFYING,
 * 跳过 Coordinator.startClarifying, 后者会直接 CREATED→PLANNING)。
 */
function setupClarifying(runId: string): Coordinator {
  const runsRoot = path.join(makeTmp(), "runs");
  const runDir = initRunDir(runsRoot, runId, "clarification 锚点测试");
  writeRunState(
    runDir,
    parseRunState({
      run_id: runId,
      complexity: "simple",
      phase: Phase.CLARIFYING,
    }),
  );
  return new Coordinator(runDir, new InlineWorkerRunner(noopWorker));
}

/** 单条阻塞性问题 (字段非空, 满足 QuestionSchema 的 refine 校验)。 */
function blockingQuestion(id = "Q1") {
  return {
    id,
    question: "应使用方案 A 还是方案 B?",
    why_blocking: "两个方案的 API 不兼容, 影响下游契约",
    default_if_unanswered: "采用方案 A (向后兼容)",
  };
}

// ---------------------------------------------------------------------------
// 1. submitClarification(非空 questions) → set clarification 锚点, phase 不变
// ---------------------------------------------------------------------------

test("submitClarification(非空 questions) → set human_pending=clarification, phase 仍 CLARIFYING", () => {
  const coord = setupClarifying("20260630-001");
  const q = parseClarificationQuestions({
    schema: "loop-engineering.clarification.v2",
    questions: [blockingQuestion()],
    skip_basis: [],
    can_proceed_with_defaults: false,
  });

  coord.submitClarification(q);

  expect(coord.state.phase).toBe(Phase.CLARIFYING);
  expect(coord.state.human_pending).toBe("clarification");
  // questions.json 落盘
  expect(
    fs.existsSync(path.join(coord.runDir, "clarification", "questions.json")),
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// 2. submitClarification(空 questions + 非空 skip_basis) → 不 set 锚点
// (无阻塞问题 → 不停人, 让主 agent 直接 startPlanning 进 PLANNING)
// ---------------------------------------------------------------------------

test("submitClarification(空 questions + 非空 skip_basis) → human_pending 仍 null (不 set)", () => {
  const coord = setupClarifying("20260630-002");
  const q = parseClarificationQuestions({
    schema: "loop-engineering.clarification.v2",
    questions: [],
    skip_basis: [
      {
        considered: "命名风格 (camelCase vs snake_case)",
        why_non_blocking: "项目已有 glossary §2 默认 camelCase, 可给无损默认",
      },
    ],
    can_proceed_with_defaults: true,
  });

  coord.submitClarification(q);

  expect(coord.state.phase).toBe(Phase.CLARIFYING);
  // 无阻塞问题 → 不 set 锚点 (让主 agent 直接 startPlanning)
  expect(coord.state.human_pending ?? null).toBeNull();
  // questions.json 仍落盘 (含空 questions + 非空 skip_basis 留证)
  expect(
    fs.existsSync(path.join(coord.runDir, "clarification", "questions.json")),
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// 3. submitClarification(非空 questions) 在 PLANNING phase 调用 → throw
// ---------------------------------------------------------------------------

test("submitClarification(非空 questions) 在 PLANNING phase 调用 → throw (含 'CLARIFYING phase')", () => {
  // 构造 phase=PLANNING 的 Coordinator (走正常 startPlanning 路径)
  const runsRoot = path.join(makeTmp(), "runs");
  const runId = "20260630-003";
  const runDir = initRunDir(runsRoot, runId, "phase 守卫测试");
  writeRunState(
    runDir,
    parseRunState({ run_id: runId, complexity: "simple", phase: Phase.CREATED }),
  );
  const coord = new Coordinator(runDir, new InlineWorkerRunner(noopWorker));
  coord.startPlanning(); // CREATED → PLANNING
  expect(coord.state.phase).toBe(Phase.PLANNING);

  const q = parseClarificationQuestions({
    schema: "loop-engineering.clarification.v2",
    questions: [blockingQuestion()],
    skip_basis: [],
    can_proceed_with_defaults: false,
  });

  let threw = false;
  let msg = "";
  try {
    coord.submitClarification(q);
  } catch (e) {
    threw = true;
    msg = e instanceof Error ? e.message : String(e);
  }
  expect(threw).toBe(true);
  expect(msg).toContain("CLARIFYING phase");
});

// ---------------------------------------------------------------------------
// 4. answerClarification(在 CLARIFYING + clarification 锚点) → 清锚点 + 推进 PLANNING
// ---------------------------------------------------------------------------

test("answerClarification(在 CLARIFYING + clarification 锚点) → 清锚点 + 推进 PLANNING", () => {
  const coord = setupClarifying("20260630-004");
  // 先 submit 设锚点
  coord.submitClarification(
    parseClarificationQuestions({
      schema: "loop-engineering.clarification.v2",
      questions: [blockingQuestion()],
      skip_basis: [],
      can_proceed_with_defaults: false,
    }),
  );
  expect(coord.state.human_pending).toBe("clarification");
  expect(coord.state.phase).toBe(Phase.CLARIFYING);

  // 用户回答 → 清锚点 + 推进 PLANNING
  const answers = parseClarificationAnswers({
    schema: "loop-engineering.clarification-answers.v1",
    answers: { Q1: "采用方案 A" },
  });
  coord.answerClarification(answers);

  expect(coord.state.phase).toBe(Phase.PLANNING);
  expect(coord.state.human_pending ?? null).toBeNull();
  // answers.json 落盘
  expect(
    fs.existsSync(path.join(coord.runDir, "clarification", "answers.json")),
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// 5. answerClarification(在 CLARIFYING + 无锚点) → 仍推进 PLANNING (向后兼容)
// (走 skip_basis 跳过路径的 run: 无阻塞→不 set 锚点→用户/主 agent 直接进 PLANNING)
// ---------------------------------------------------------------------------

test("answerClarification(在 CLARIFYING + 无锚点) → 仍推进 PLANNING (向后兼容)", () => {
  const coord = setupClarifying("20260630-005");
  // 走"空 questions"路径: submit 不 set 锚点
  coord.submitClarification(
    parseClarificationQuestions({
      schema: "loop-engineering.clarification.v2",
      questions: [],
      skip_basis: [
        {
          considered: "命名风格",
          why_non_blocking: "有无损默认",
        },
      ],
      can_proceed_with_defaults: true,
    }),
  );
  expect(coord.state.human_pending ?? null).toBeNull();
  expect(coord.state.phase).toBe(Phase.CLARIFYING);

  // 即使无锚点, answerClarification 也应推进 PLANNING (向后兼容老路径)
  const answers = parseClarificationAnswers({
    schema: "loop-engineering.clarification-answers.v1",
    answers: {},
  });
  coord.answerClarification(answers);

  expect(coord.state.phase).toBe(Phase.PLANNING);
  expect(coord.state.human_pending ?? null).toBeNull();
});
