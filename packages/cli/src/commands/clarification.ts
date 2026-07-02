/**
 * e2e-loop clarification 子命令 (人盯点 0, CLARIFYING phase)。
 *
 * 主 agent (Claude Code 主会话) 不能直接调 Coordinator TS 方法, 必须经此 CLI 子命令触发:
 *   - submit-clarification: 主 agent dispatch clarification-finder 子 agent 后调用,
 *     让 Coordinator 读取 clarification/questions.json 并落盘 (若 questions 非空, 告知
 *     主 agent 用 AskUserQuestion 弹结构化框收答案; 若空则留 skip_basis 直接进 plan)。
 *   - answer-clarification: 用户答完后调用, 把答案落 clarification/answers.json + 推进 PLANNING。
 *
 * 设计要点 (与 dryrun.ts 风格一致):
 *   - 错误 → stderr + 返回非 0 (参数缺失 / 文件不存在 → 2; 运行期 throw 由 index.ts
 *     的 dryRunGuard 兜成 1)。
 *   - 复用 dryrun.ts 的 helpers (resolveRunsRoot / resolveRunDir / positional /
 *     makeRunner / humanPendingText), 不重复造轮子。
 *   - questions 非空与否决定输出提示语: 非空 → 人盯锚点应被 set; 空 → 无阻塞 (skip_basis 留证)。
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { Coordinator } from "@e2e-loop/ssot/runtime";
import {
  parseClarificationAnswers,
  parseClarificationQuestions,
} from "@e2e-loop/ssot/schema";

import type { Args } from "../args.js";
import {
  makeRunner,
  positional,
  resolveRunDir,
  resolveRunsRoot,
  humanPendingText,
} from "./dryrun.js";

// ---------------------------------------------------------------------------
// submit-clarification
// ---------------------------------------------------------------------------

/**
 * submit-clarification 子命令。
 *
 * 用法: e2e-loop submit-clarification <run_id> [--runs-root <dir>]
 *
 * 读取 clarification/questions.json → 调 coord.submitClarification 落盘。questions 非空时
 * 提示主 agent 用 AskUserQuestion 收答案; 空时提示直接进 plan。
 */
export function runSubmitClarification(args: Args): number {
  const runId = positional(args, 0);
  if (!runId) {
    process.stderr.write("错误: submit-clarification 需要位置参数 <run_id>\n");
    return 2;
  }
  const runsRoot = resolveRunsRoot(args);
  const runDir = resolveRunDir(runsRoot, runId);

  const questionsPath = path.join(runDir, "clarification", "questions.json");
  if (!fs.existsSync(questionsPath)) {
    process.stderr.write(
      "错误: 未找到 clarification/questions.json, 先 dispatch clarification-finder 子 agent\n",
    );
    return 2;
  }
  let rawJson: string;
  try {
    rawJson = fs.readFileSync(questionsPath, "utf-8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`错误: 读取 clarification/questions.json 失败: ${msg}\n`);
    return 2;
  }
  let q;
  try {
    q = parseClarificationQuestions(JSON.parse(rawJson));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`错误: clarification/questions.json 解析失败: ${msg}\n`);
    return 2;
  }

  const coord = new Coordinator(runDir, makeRunner());
  coord.submitClarification(q);

  const hp = q.questions.length > 0 ? "clarification" : "none";
  process.stdout.write(
    `run ${runId}: clarification submitted, questions=${q.questions.length}, ` +
      `skip_basis=${q.skip_basis.length}, human_pending=${hp}\n`,
  );
  if (q.questions.length > 0) {
    process.stdout.write(
      "已 set clarification 锚点。请用 AskUserQuestion 弹结构化框 (每个 question 一项, " +
        "推荐选项 = default_if_unanswered), 用户答完后调 answer-clarification 推进。\n",
    );
  } else {
    process.stdout.write(
      "无阻塞问题 (skip_basis 留证), 未 set 锚点。可直接调 plan 子命令进 PLANNING。\n",
    );
  }
  return 0;
}

// ---------------------------------------------------------------------------
// answer-clarification
// ---------------------------------------------------------------------------

/**
 * answer-clarification 子命令。
 *
 * 用法: e2e-loop answer-clarification <run_id> --answers <json-file> [--runs-root <dir>]
 *
 * 读取 --answers 指向的 JSON 文件 → 调 coord.answerClarification 落 answers.json + 推进。
 */
export function runAnswerClarification(args: Args): number {
  const runId = positional(args, 0);
  if (!runId) {
    process.stderr.write("错误: answer-clarification 需要位置参数 <run_id>\n");
    return 2;
  }
  const answersFile = args.values.answers;
  if (!answersFile) {
    process.stderr.write("错误: answer-clarification 需要 --answers <json-file>\n");
    return 2;
  }

  const runsRoot = resolveRunsRoot(args);
  const runDir = resolveRunDir(runsRoot, runId);

  const answersPath = path.resolve(answersFile);
  if (!fs.existsSync(answersPath)) {
    process.stderr.write(`错误: 答案文件不存在: ${answersPath}\n`);
    return 2;
  }
  let rawJson: string;
  try {
    rawJson = fs.readFileSync(answersPath, "utf-8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`错误: 读取答案文件失败: ${msg}\n`);
    return 2;
  }
  let answers;
  try {
    answers = parseClarificationAnswers(JSON.parse(rawJson));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`错误: 答案文件解析失败: ${msg}\n`);
    return 2;
  }

  const coord = new Coordinator(runDir, makeRunner());
  coord.answerClarification(answers);
  process.stdout.write(
    `run ${runId}: clarification answered, phase=${coord.state.phase}, ` +
      `human_pending=${humanPendingText(coord.state.human_pending)}\n`,
  );
  return 0;
}
