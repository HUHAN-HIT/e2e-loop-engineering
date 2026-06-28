/**
 * fixtures/ 共享夹具冒烟测试。
 *
 * 目的: 验证 `tests-ts/fixtures/runs/20260101-001/` 这份"已知"夹具在
 *       `LOOP_RUNS_ROOT` 指向它时, 4 个 hook 的关键路径都能正常解析与决策。
 *       不依赖每个用例自建的独立 tmpdir, 而是固化一条"夹具根"路径作为回归锚点。
 *
 * 行为权威: Python tests/test_hooks_smoke.py (各 hook 的最简 happy-path)
 */
import { test, expect, afterEach } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  handleProbeAndGate,
  handleGuardPaths,
  handleGuardAnchors,
  handlePostTaskCollect,
  type HookInput,
} from "@e2e-loop/shared";

const _envBackup = process.env.LOOP_RUNS_ROOT;
const FIXTURES_ROOT = path.resolve(import.meta.dirname, "fixtures");

afterEach(() => {
  if (_envBackup === undefined) delete process.env.LOOP_RUNS_ROOT;
  else process.env.LOOP_RUNS_ROOT = _envBackup;
});

test("fixtures/ 存在 run-state.json 与 task-plan.yaml", () => {
  const runDir = path.join(FIXTURES_ROOT, "runs", "20260101-001");
  expect(fs.existsSync(path.join(runDir, "run-state.json"))).toBe(true);
  expect(fs.existsSync(path.join(runDir, "planning", "task-plan.yaml"))).toBe(true);
});

test("fixtures/ + LOOP_RUNS_ROOT 指向 fixtures: probe_and_gate defer + active_run 非 null", async () => {
  process.env.LOOP_RUNS_ROOT = path.join(FIXTURES_ROOT, "runs");
  const input: HookInput = { event: "SessionStart", cwd: FIXTURES_ROOT };
  const out = await handleProbeAndGate(input);
  expect(out.decision).toBe("defer");
  expect(out.context!.active_run).not.toBe(null);
  expect(out.context!.phase).toBe("IMPLEMENTING");
});

test("fixtures/ + LOOP_RUNS_ROOT: guard_paths 写 .claude/x → deny", async () => {
  process.env.LOOP_RUNS_ROOT = path.join(FIXTURES_ROOT, "runs");
  const input: HookInput = {
    event: "PreToolUse",
    toolName: "Write",
    toolInput: { file_path: path.join(FIXTURES_ROOT, ".claude", "x.txt"), content: "x" },
    cwd: FIXTURES_ROOT,
  };
  const out = await handleGuardPaths(input);
  expect(out.decision).toBe("deny");
  expect(out.reason ?? "").toContain(".claude");
});

test("fixtures/ + LOOP_RUNS_ROOT: guard_paths 写 src/foo.ts (allowed) → allow", async () => {
  process.env.LOOP_RUNS_ROOT = path.join(FIXTURES_ROOT, "runs");
  const input: HookInput = {
    event: "PreToolUse",
    toolName: "Write",
    toolInput: { file_path: path.join(FIXTURES_ROOT, "src", "foo.ts"), content: "x" },
    cwd: FIXTURES_ROOT,
  };
  const out = await handleGuardPaths(input);
  expect(out.decision).toBe("allow");
});

test("fixtures/ + LOOP_RUNS_ROOT: guard_anchors 无 test-results.yaml → deny", async () => {
  process.env.LOOP_RUNS_ROOT = path.join(FIXTURES_ROOT, "runs");
  const input: HookInput = { event: "Stop", cwd: FIXTURES_ROOT };
  const out = await handleGuardAnchors(input);
  expect(out.decision).toBe("deny");
  expect(out.reason ?? "").toContain("test-results.yaml");
});

test("fixtures/ + LOOP_RUNS_ROOT: post_task_collect 非 loop worker → allow", async () => {
  process.env.LOOP_RUNS_ROOT = path.join(FIXTURES_ROOT, "runs");
  const input: HookInput = {
    event: "PostToolUse",
    toolName: "Task",
    toolInput: { subagent_type: "some-other", prompt: "..." },
    toolResponse: { result: "ok" },
    cwd: FIXTURES_ROOT,
  };
  const out = await handlePostTaskCollect(input);
  expect(out.decision).toBe("allow");
});
