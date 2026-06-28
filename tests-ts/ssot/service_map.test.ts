/**
 * service_map 等价测试 (P4-M5, §11.4)。
 *
 * 行为权威: Python `tests/test_service_map.py` + `loop_engineering/multi_service/service_map.py`。
 * 被测实现: `packages/ssot-ts/src/multi_service/service_map.ts`。
 *
 * 覆盖: resolveWorktree (基本/缺失抛错)、resolveWorktreeForTask (null→"." / 有 service)、
 * validateServiceMap (缺目录报问题 / 全在返回空)、collectActualWritesMultiRepo (前缀化 / null 退化)。
 *
 * 路径表示: Python 用 pathlib.Path, TS 用字符串路径; 比较与拼接均按 POSIX 风格。
 */
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";

import {
  collectActualWritesMultiRepo,
  resolveWorktree,
  resolveWorktreeForTask,
  validateServiceMap,
} from "../../packages/ssot-ts/src/multi_service/service_map.js";
import type { ServiceMap, Task } from "@e2e-loop/ssot";
import { ServiceMapSchema, TaskSchema } from "@e2e-loop/ssot";

function mkServiceMap(services: Record<string, { worktree: string }>): ServiceMap {
  return ServiceMapSchema.parse({ services });
}

function mkTask(opts: { service?: string | null } = {}): Task {
  return TaskSchema.parse({
    id: "T1",
    title: "t",
    allowed_write_paths: ["a/**"],
    acceptance_refs: ["AC1"],
    service: opts.service ?? null,
  });
}

// ---------- resolveWorktree ----------

test("[py: TestResolveWorktree.test_basic] service → worktree 路径", () => {
  const sm = mkServiceMap({ auth: { worktree: "repos/auth" } });
  expect(resolveWorktree(sm, "auth")).toBe("repos/auth");
});

test("[py: TestResolveWorktree.test_missing_raises] 缺失 service 抛错 (等价 KeyError)", () => {
  const sm = mkServiceMap({ auth: { worktree: "repos/auth" } });
  expect(() => resolveWorktree(sm, "billing")).toThrow();
});

// ---------- resolveWorktreeForTask ----------

test("[py: TestResolveWorktreeForTask.test_none_service_returns_dot] service=null → '.'", () => {
  const sm = mkServiceMap({});
  const t = mkTask({ service: null });
  expect(resolveWorktreeForTask(sm, t)).toBe(".");
});

test("[py: TestResolveWorktreeForTask.test_with_service] 有 service → 对应 worktree", () => {
  const sm = mkServiceMap({ auth: { worktree: "repos/auth" } });
  const t = mkTask({ service: "auth" });
  expect(resolveWorktreeForTask(sm, t)).toBe("repos/auth");
});

// ---------- validateServiceMap ----------

test("[py: TestValidateServiceMap.test_finds_missing_dirs] 缺目录 → 报问题", () => {
  const base = mkdtempSync(nodePath.join(tmpdir(), "svcmap-"));
  try {
    // base 下不存在 repos/auth
    const sm = mkServiceMap({ auth: { worktree: "repos/auth" } });
    const problems = validateServiceMap(sm, base);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.includes("auth"))).toBe(true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("[py: TestValidateServiceMap.test_all_present] 目录全在 → 空问题列表", () => {
  const base = mkdtempSync(nodePath.join(tmpdir(), "svcmap-"));
  try {
    mkdirSync(nodePath.join(base, "repos", "auth"), { recursive: true });
    const sm = mkServiceMap({ auth: { worktree: "repos/auth" } });
    const problems = validateServiceMap(sm, base);
    expect(problems).toEqual([]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------- collectActualWritesMultiRepo ----------

test("[py: TestCollectActualWritesMultiRepo.test_combines_services_with_prefix] 按 service 前缀化写入清单", () => {
  const sm = mkServiceMap({
    auth: { worktree: "repos/auth" },
    gateway: { worktree: "repos/gateway" },
  });
  const t = mkTask({ service: "auth" });
  const writes = collectActualWritesMultiRepo(sm, t, {
    auth: ["src/auth.py", "tests/test_auth.py"],
    gateway: ["src/gw.py"],
  });
  expect(writes).toEqual(["repos/auth/src/auth.py", "repos/auth/tests/test_auth.py"]);
});

test("[py: TestCollectActualWritesMultiRepo.test_none_service_returns_raw] service=null → 原样返回", () => {
  const sm = mkServiceMap({});
  const t = mkTask({ service: null });
  const writes = collectActualWritesMultiRepo(sm, t, { "": ["src/x.py"] });
  expect(writes).toEqual(["src/x.py"]);
});
