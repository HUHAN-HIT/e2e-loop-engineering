/**
 * collect.ts::collectActualWrites harness 内部路径过滤 (框架 bug 回归)。
 *
 * 根因 (已确诊): 存在两套 actual_writes 采集实现:
 *   - packages/shared/src/actual_writes.ts 的 computeActualWrites 对 git/fs/self_report 三层
 *     结果都做了 `.filter(p => !isHarnessInternal(p))` (过滤 runs/ .claude/ 等 harness 产物)。
 *   - packages/ssot-ts/src/dispatch/collect.ts 的 collectActualWrites 此前**没有任何过滤**,
 *     直接返回 tryGitDiff / collectViaFsSnapshot / workerSelfReport 结果。
 *
 * 后果: worker 把自己的强制产物 (summary.md/test-results.yaml/key-diffs.yaml) 写进 worktree 里的
 * runs/<id>/tasks/<tid>/, git status 把整个未跟踪的 runs/ 折叠成一条 "runs/",
 * collectActualWrites 返回它, detectOutOfBounds 拿它比对 task.allowed_write_paths (如 ["docs/x.md"])
 * → 误判越界 oob=["runs/"]。这是框架 bug, 不能靠加宽 allowed_write_paths 绕过。
 *
 * 本测试锁定: collectActualWrites 与 computeActualWrites 对齐, 三层采集都过滤 harness 内部路径。
 * 被测实现: packages/ssot-ts/src/dispatch/collect.ts (collectActualWrites / detectOutOfBounds)。
 *
 * import 风格: 照 integration_dispatch_collect.test.ts 直接从源码路径 import (dispatch 子包在
 * @e2e-loop/ssot 顶层是命名空间导出, 直接从 collect.js 拿更直白)。
 */
import { test, expect } from "bun:test";
import {
  collectActualWrites,
  detectOutOfBounds,
  type FsSnapshot,
} from "../packages/ssot-ts/src/dispatch/collect.js";
import { TaskSchema } from "../packages/ssot-ts/src/schema/task_plan.js";
import type { RunCapabilities } from "../packages/ssot-ts/src/schema/run_state.js";

/** fs_snapshot 能力开启, git 关闭 (逼走 fs_snapshot 采集分支)。 */
const FS_CAPS: RunCapabilities = { git_diff: false, fs_snapshot: true };

/** 构造一个最小 task (走 zod 填默认值), 只指定必填 + allowed_write_paths。 */
function makeTask(allowed: string[]) {
  return TaskSchema.parse({
    id: "T01",
    title: "demo",
    allowed_write_paths: allowed,
    acceptance_refs: ["AC-1"],
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// fs_snapshot 分支: harness 产物 (runs/...) 被过滤, 真实源码保留
// ═══════════════════════════════════════════════════════════════════════════

test("[回归] collectActualWrites fs_snapshot 分支过滤 runs/ harness 产物, 只留 docs/x.md", () => {
  // before/after mtime 差异 = 被写过。含: worker 强制产物 (runs/.../summary.md) + 真实源码 (docs/x.md)。
  const before: FsSnapshot = { "docs/x.md": 1000 };
  const after: FsSnapshot = {
    "docs/x.md": 2000, // mtime 变化 → 被写
    "runs/20260101-001/tasks/T01/summary.md": 3000, // 新增 harness 产物 → 应被过滤
  };

  const collection = collectActualWrites("/tmp/workdir", "T01", FS_CAPS, {
    beforeSnapshot: before,
    afterSnapshot: after,
  });

  expect(collection.source).toBe("fs_snapshot");
  expect(collection.is_authoritative).toBe(true);
  // 只含真实源码, 不含任何 runs/ 路径
  expect(collection.writes).toEqual(["docs/x.md"]);
  expect(collection.writes.some((p) => p.startsWith("runs/"))).toBe(false);
});

test("[回归] git status 折叠的整目录条目 'runs/' 也被过滤", () => {
  // 模拟 git status 把整个 untracked runs/ 折叠成单条 "runs/" 的情形。
  const before: FsSnapshot = {};
  const after: FsSnapshot = {
    "runs/": 3000,
    "docs/x.md": 2000,
  };

  const collection = collectActualWrites("/tmp/workdir", "T01", FS_CAPS, {
    beforeSnapshot: before,
    afterSnapshot: after,
  });

  expect(collection.writes).toEqual(["docs/x.md"]);
  expect(collection.writes).not.toContain("runs/");
});

// ═══════════════════════════════════════════════════════════════════════════
// 端到端: 过滤后的 collection 喂 detectOutOfBounds → 不再误判越界
// ═══════════════════════════════════════════════════════════════════════════

test("[回归·端到端] 过滤后 detectOutOfBounds(allowed=['docs/x.md']) → is_oob=false, out_of_bounds=[]", () => {
  const before: FsSnapshot = { "docs/x.md": 1000 };
  const after: FsSnapshot = {
    "docs/x.md": 2000,
    "runs/20260101-001/tasks/T01/summary.md": 3000,
    "runs/20260101-001/tasks/T01/test-results.yaml": 3000,
    "runs/20260101-001/tasks/T01/key-diffs.yaml": 3000,
  };

  const collection = collectActualWrites("/tmp/workdir", "T01", FS_CAPS, {
    beforeSnapshot: before,
    afterSnapshot: after,
  });

  const task = makeTask(["docs/x.md"]);
  const oob = detectOutOfBounds(task, collection);

  expect(oob.is_oob).toBe(false);
  expect(oob.out_of_bounds).toEqual([]);
  // actual_writes 里也不应残留 harness 产物
  expect(oob.actual_writes).toEqual(["docs/x.md"]);
});

// ═══════════════════════════════════════════════════════════════════════════
// .claude/ 等其它 harness 产物也被过滤 (可选覆盖)
// ═══════════════════════════════════════════════════════════════════════════

test("[回归] .claude/ 与 resume.* 等 harness 产物同样被过滤", () => {
  const before: FsSnapshot = {};
  const after: FsSnapshot = {
    ".claude/settings.json": 3000,
    "resume.cmd": 3000,
    ".worktrees/wt1/x": 3000,
    "src/real.ts": 2000,
  };

  const collection = collectActualWrites("/tmp/workdir", "T01", FS_CAPS, {
    beforeSnapshot: before,
    afterSnapshot: after,
  });

  expect(collection.writes).toEqual(["src/real.ts"]);
  expect(collection.writes.some((p) => p.startsWith(".claude/"))).toBe(false);
  expect(collection.writes).not.toContain("resume.cmd");
  expect(collection.writes.some((p) => p.startsWith(".worktrees/"))).toBe(false);
});

// ═══════════════════════════════════════════════════════════════════════════
// worker_self_report 分支同样过滤 (三层一致)
// ═══════════════════════════════════════════════════════════════════════════

test("[回归] worker_self_report 分支也过滤 harness 产物", () => {
  // 无 git 无快照 → 走 self_report。workerSelfReport 里混入 runs/ 产物。
  const noCaps: RunCapabilities = { git_diff: false, fs_snapshot: false };
  const collection = collectActualWrites("/tmp/workdir", "T01", noCaps, {
    workerSelfReport: [
      "runs/20260101-001/tasks/T01/summary.md",
      "docs/x.md",
    ],
  });

  expect(collection.source).toBe("worker_self_report");
  expect(collection.is_authoritative).toBe(false);
  expect(collection.writes).toEqual(["docs/x.md"]);
});
