/**
 * readTaskPlanDiag 诊断测试。
 *
 * 被测实现: packages/shared/src/task_plan.ts (readTaskPlanDiag / readTaskPlan)。
 *
 * 关键: 区分 missing / parse_error / invalid / ok 四态。老 readTaskPlan 把前三者都压成 null,
 * hook 无法给出精确诊断; readTaskPlanDiag 让 parse_error 携带行号+冒号提示 (自愈闭环)。
 */
import { test, expect, describe, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  readTaskPlanDiag,
  readTaskPlan,
} from "../packages/shared/src/task_plan.js";

const tmpDirs: string[] = [];

/** 建一个临时 runDir, 可选写入 planning/task-plan.yaml。 */
function mkRun(planText?: string): string {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-diag-"));
  tmpDirs.push(runDir);
  if (planText !== undefined) {
    const planningDir = path.join(runDir, "planning");
    fs.mkdirSync(planningDir, { recursive: true });
    fs.writeFileSync(path.join(planningDir, "task-plan.yaml"), planText, "utf-8");
  }
  return runDir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

const GOOD_PLAN = [
  "complexity: simple",
  "tasks:",
  "  - id: T01",
  '    title: "做点事"',
  "    allowed_write_paths: [src/a.ts]",
  "    acceptance_refs: [AC-001]",
].join("\n");

const BAD_PLAN = [
  "complexity: complex",
  "tasks:",
  "  - id: T01",
  '    title: "x"',
  "    allowed_write_paths: [src/a.ts]",
  "    acceptance_refs: [AC-001]",
  "    tests:",
  "      - id: T01-CASE-001",
  "        scenario: 负向: 冒号未加引号会炸",
  "        checks: []",
].join("\n");

describe("readTaskPlanDiag", () => {
  test("文件不存在 → missing", () => {
    const runDir = mkRun(); // 不写 plan
    expect(readTaskPlanDiag(runDir).status).toBe("missing");
  });

  test("YAML 语法错 (未引用冒号) → parse_error 且 message 带行号+冒号提示", () => {
    const runDir = mkRun(BAD_PLAN);
    const r = readTaskPlanDiag(runDir);
    expect(r.status).toBe("parse_error");
    if (r.status === "parse_error") {
      expect(r.message).toContain("第");
      expect(r.message).toContain("未加引号的冒号");
    }
  });

  test("YAML 合法但结构非法 (无 tasks) → invalid", () => {
    const runDir = mkRun("foo: bar\n");
    expect(readTaskPlanDiag(runDir).status).toBe("invalid");
  });

  test("合法 plan → ok 且 plan.tasks 正确", () => {
    const runDir = mkRun(GOOD_PLAN);
    const r = readTaskPlanDiag(runDir);
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.plan.tasks.length).toBe(1);
      expect(r.plan.tasks[0]!.id).toBe("T01");
      expect(r.plan.schema).toBe("loop-engineering.task-plan.v2"); // 默认补齐
    }
  });
});

describe("readTaskPlan (兼容旧签名)", () => {
  test("坏 plan → null", () => {
    expect(readTaskPlan(mkRun(BAD_PLAN))).toBeNull();
  });
  test("好 plan → 非空", () => {
    expect(readTaskPlan(mkRun(GOOD_PLAN))).not.toBeNull();
  });
});
