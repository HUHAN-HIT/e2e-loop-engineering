/**
 * harness 冒烟测试。
 *
 * 目的: 验证 bun:test 能跑、且 workspace 导入 (@e2e-loop/shared) 解析正常。
 * 这是 tests-ts/ 目录的最小可运行样例, 长期保留作为 harness 健康探针。
 */
import { test, expect } from "bun:test";
import { matchPath } from "@e2e-loop/shared";

test("matchPath: src/** 命中 src/a.ts", () => {
  // ** 跨任意层级, src/a.ts 应命中
  expect(matchPath("src/**", "src/a.ts")).toBe(true);
});
