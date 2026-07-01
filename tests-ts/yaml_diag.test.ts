/**
 * yaml_diag 单元测试 + readTaskPlan 止崩集成测试。
 *
 * 被测实现:
 * - packages/shared/src/yaml_diag.ts (describeYamlError / parseYamlSafe)
 * - packages/ssot-ts/src/runtime/directory.ts (readTaskPlan / readTaskDetail 的可读诊断)
 *
 * 动机: plan-agent 手写 task-plan.yaml 时中文 scenario 值含未引用冒号 (`: `), 导致 js-yaml
 * 抛不可读异常, Coordinator 构造函数崩。本测试锁定"崩溃 → 可执行诊断"的转换。
 */
import { test, expect, describe } from "bun:test";
import * as yaml from "js-yaml";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  describeYamlError,
  parseYamlSafe,
} from "../packages/shared/src/yaml_diag.js";
import { readTaskPlan } from "../packages/ssot-ts/src/runtime/directory.js";

/** 一段复刻真实故障的非法 yaml: scenario 值含未引用的 `负向: ...`。 */
const BAD_YAML = [
  "complexity: complex",
  "tasks:",
  "  - id: T03",
  '    title: "状态机"',
  "    tests:",
  "      - id: T03-CASE-002",
  "        scenario: 负向: 尝试将 DONE 状态推进回 RUNNING, 状态机拒绝",
  "        checks:",
  '          - "transition_rejected == true"',
].join("\n");

/** 捕获 js-yaml 对 BAD_YAML 抛出的真实异常 (用于喂给 describeYamlError)。 */
function captureYamlError(text: string): unknown {
  try {
    yaml.load(text);
    throw new Error("预期抛异常但未抛");
  } catch (e) {
    return e;
  }
}

describe("describeYamlError", () => {
  test("YAMLException + 未引用冒号 → 带行号与冒号修复提示", () => {
    const err = captureYamlError(BAD_YAML);
    const msg = describeYamlError("planning/task-plan.yaml", BAD_YAML, err);
    expect(msg).toContain("planning/task-plan.yaml");
    expect(msg).toContain("YAML 解析失败");
    expect(msg).toContain("第"); // 行号展示
    expect(msg).toContain("未加引号的冒号");
    expect(msg).toContain("scenario:"); // 修复示例
  });

  test("非 YAMLException → 原样透传 message, 不臆造冒号提示", () => {
    const msg = describeYamlError("x.yaml", "irrelevant", new Error("boom"));
    expect(msg).toBe("x.yaml 解析失败: boom");
    expect(msg).not.toContain("未加引号的冒号");
  });

  test("YAMLException 但该行无未引用冒号 → 不追加冒号提示", () => {
    // 缩进错误 (与冒号无关) 触发的 YAMLException。
    const badIndent = ["a:", "  b: 1", " c: 2"].join("\n");
    const err = captureYamlError(badIndent);
    const msg = describeYamlError("x.yaml", badIndent, err);
    expect(msg).toContain("YAML 解析失败");
    expect(msg).not.toContain("未加引号的冒号");
  });
});

describe("parseYamlSafe", () => {
  test("合法 yaml → ok:true 且 data 正确", () => {
    const res = parseYamlSafe("ok.yaml", "a: 1\nb: two\n");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ a: 1, b: "two" });
  });

  test("非法 yaml → ok:false 且 message 含行号", () => {
    const res = parseYamlSafe("bad.yaml", BAD_YAML);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toContain("第");
      expect(res.message).toContain("未加引号的冒号");
    }
  });
});

describe("readTaskPlan (directory.ts) 止崩", () => {
  test("非法冒号 task-plan.yaml → throw 带行号与冒号提示 (非裸 js-yaml 堆栈)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yaml-diag-"));
    const planPath = path.join(dir, "task-plan.yaml");
    fs.writeFileSync(planPath, BAD_YAML, "utf-8");
    try {
      expect(() => readTaskPlan(planPath)).toThrow(/未加引号的冒号/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("文件不存在 → throw 明确的 '不存在' 错误", () => {
    const missing = path.join(os.tmpdir(), "no-such-dir-xyz", "task-plan.yaml");
    expect(() => readTaskPlan(missing)).toThrow(/不存在/);
  });
});
