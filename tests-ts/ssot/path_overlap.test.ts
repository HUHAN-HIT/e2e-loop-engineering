/**
 * path_overlap 等价测试 (P4-M3, design §3.2 + §11.1)。
 *
 * 行为权威: Python `tests/test_path_overlap.py` + `loop_engineering/scheduling/path_overlap.py`。
 * 被测实现: `packages/ssot-ts/src/scheduling/path_overlap.ts`。
 *
 * 覆盖: pathGlobsOverlap 的 §3.2 点名 case (判不准保守 True) + conflicts 的 9 条
 * service-aware 写冲突用例 (P1 时缺失、本里程碑补齐的 TestConflicts)。
 */
import { test, expect } from "bun:test";

import {
  conflicts,
  pathGlobsOverlap,
} from "../../packages/ssot-ts/src/scheduling/path_overlap.js";
import { TaskSchema } from "../../packages/ssot-ts/src/schema/task_plan.js";
import type { Task } from "../../packages/ssot-ts/src/schema/task_plan.js";

// ---------------- pathGlobsOverlap ----------------

test("[py: test_recursive_includes_nested] a/** vs a/b.py → True (前缀包含)", () => {
  expect(pathGlobsOverlap(["a/**"], ["a/b.py"])).toBe(true);
});

test("[py: test_star_vs_double_star_recursive] *.py vs ** → True (单层 vs 递归)", () => {
  expect(pathGlobsOverlap(["*.py"], ["**"])).toBe(true);
});

test("[py: test_star_does_not_cross_slash] a/*.py vs a/b/c.py → False (* 不跨 /)", () => {
  expect(pathGlobsOverlap(["a/*.py"], ["a/b/c.py"])).toBe(false);
});

test("[py: test_double_star_crosses_slash] a/** vs a/b/c/d.py → True (深层文件被递归覆盖)", () => {
  expect(pathGlobsOverlap(["a/**"], ["a/b/c/d.py"])).toBe(true);
});

test("[py: test_exact_path_match] a/b.py vs a/b.py → True", () => {
  expect(pathGlobsOverlap(["a/b.py"], ["a/b.py"])).toBe(true);
});

test("[py: test_disjoint_paths] a/** vs b/** → False (互不相交)", () => {
  expect(pathGlobsOverlap(["a/**"], ["b/**"])).toBe(false);
});

test("[py: test_directory_glob_expands] a (末尾无 /) vs a/b.py → True (目录缩写)", () => {
  expect(pathGlobsOverlap(["a"], ["a/b.py"])).toBe(true);
});

test("[py: test_negation_pattern_conservative_true] 含 !secret/** → True (判不准保守)", () => {
  expect(pathGlobsOverlap(["!secret/**"], ["public/x.py"])).toBe(true);
});

test("[py: test_unknown_syntax_conservative_true] 含 [abc] 字符类 → True (判不准保守)", () => {
  expect(pathGlobsOverlap(["src/[abc]/x.py"], ["src/b/x.py"])).toBe(true);
});

test("[py: test_empty_globs_do_not_overlap] 空 allowed_write_paths 永不冲突", () => {
  expect(pathGlobsOverlap([], ["a/**"])).toBe(false);
  expect(pathGlobsOverlap(["a/**"], [])).toBe(false);
  expect(pathGlobsOverlap([], [])).toBe(false);
});

test("[py: test_multiple_globs_any_overlap] 多 glob 列表: 任一 pair 重叠即 True", () => {
  // y/* 与 y/z.py 单层重叠。
  expect(pathGlobsOverlap(["a/**", "y/*"], ["b/c.py", "y/z.py"])).toBe(true);
  // 对照: 真正不相交时为 False。
  expect(pathGlobsOverlap(["a/**", "x/*"], ["b/c.py", "y/z.py"])).toBe(false);
});

test("[py: test_glob_at_end_matches_files_only] a/** vs a → True (递归覆盖目录缩写本身)", () => {
  expect(pathGlobsOverlap(["a/**"], ["a"])).toBe(true);
});

test("[py: test_double_star_middle_matches_zero_levels] a/**/b.py 与 a/b.py 及 a/x/b.py 都重叠", () => {
  expect(pathGlobsOverlap(["a/**/b.py"], ["a/b.py"])).toBe(true);
  expect(pathGlobsOverlap(["a/**/b.py"], ["a/x/b.py"])).toBe(true);
});

test("[py: test_brace_expansion_conservative_true] 含 {a,b} brace 展开 → True (判不准保守)", () => {
  expect(pathGlobsOverlap(["src/{a,b}/x.py"], ["src/a/x.py"])).toBe(true);
});

// ---------------- conflicts (P1 缺失的 service-aware 写冲突, §11.1) ----------------

/** 构造测试 task (最小字段, 经 zod 补默认值)。 */
function makeTask(
  tid: string,
  paths: string[],
  opts: { exclusive?: boolean; service?: string | null } = {},
): Task {
  return TaskSchema.parse({
    id: tid,
    title: tid,
    allowed_write_paths: paths,
    acceptance_refs: [],
    exclusive: opts.exclusive ?? false,
    service: opts.service ?? null,
  });
}

test("[py: test_conflicts_same_service_path_overlap] 同服务 + 路径重叠 → True", () => {
  const a = makeTask("a", ["src/auth/**"], { service: "auth" });
  const b = makeTask("b", ["src/auth/login.py"], { service: "auth" });
  expect(conflicts(a, b)).toBe(true);
});

test("[py: test_conflicts_same_service_no_overlap] 同服务 + 路径不交 → False", () => {
  const a = makeTask("a", ["src/auth/**"], { service: "auth" });
  const b = makeTask("b", ["src/gateway/**"], { service: "auth" });
  expect(conflicts(a, b)).toBe(false);
});

test("[py: test_conflicts_cross_service_never] §11.1 C2: 跨服务永不冲突, 即使路径同名", () => {
  const a = makeTask("a", ["src/shared.py"], { service: "auth" });
  const b = makeTask("b", ["src/shared.py"], { service: "gateway" });
  expect(conflicts(a, b)).toBe(false);
});

test("[py: test_conflicts_exclusive_same_service] 同服务任一 exclusive → True", () => {
  const a = makeTask("a", ["src/auth/**"], { exclusive: true, service: "auth" });
  const b = makeTask("b", ["src/gateway/**"], { service: "auth" });
  expect(conflicts(a, b)).toBe(true);
});

test("[py: test_conflicts_exclusive_cross_service] §11.1: 跨 service 即使 exclusive 也 False", () => {
  const a = makeTask("a", ["src/**"], { exclusive: true, service: "auth" });
  const b = makeTask("b", ["src/**"], { service: "gateway" });
  expect(conflicts(a, b)).toBe(false);
});

test("[py: test_conflicts_no_service_treated_as_same] 双方 service=null → 按同服务判", () => {
  const a = makeTask("a", ["src/**"]);
  const b = makeTask("b", ["src/x.py"]);
  expect(conflicts(a, b)).toBe(true);
});

test("[py: test_conflicts_mixed_service_null] service=null vs service='auth' → 任一 null 视为同服务", () => {
  const a = makeTask("a", ["src/**"], { service: null });
  const b = makeTask("b", ["src/x.py"], { service: "auth" });
  expect(conflicts(a, b)).toBe(true);
});

test("[py: test_conflicts_both_exclusive_same_service] 同服务双 exclusive → True", () => {
  const a = makeTask("a", ["x"], { exclusive: true, service: "auth" });
  const b = makeTask("b", ["y"], { exclusive: true, service: "auth" });
  expect(conflicts(a, b)).toBe(true);
});
