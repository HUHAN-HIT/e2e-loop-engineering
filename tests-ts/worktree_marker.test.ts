/**
 * shared 侧 worktree 根 marker helper 测试 (spec 改动① 测试点 3)。
 *
 * 覆盖:
 * - readWorktreeMarker: 合法 marker → 解析出 schema/owner/run_id/created_at;
 *   不存在 / JSON 损坏 / owner 不符 / 缺字段 → 返回 null (轻量校验, 不引 zod)。
 * - isInLoopWorktree: cwd 下有合法 marker → true; 否则 false。
 *
 * 隔离: 每个用例独立 mkdtemp, afterEach 清理。
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  WORKTREE_MARKER_REL,
  WORKTREE_MARKER_SCHEMA,
  WORKTREE_MARKER_OWNER,
  readWorktreeMarker,
  isInLoopWorktree,
} from "@e2e-loop/shared";

const _toClean: string[] = [];

afterEach(() => {
  while (_toClean.length) {
    const d = _toClean.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响断言 */
    }
  }
});

function makeTmp(prefix = "loop-marker-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  _toClean.push(dir);
  return dir;
}

/** 在 worktreeRoot 下写一份 marker 文件 (可注入残缺内容)。 */
function writeMarkerRaw(worktreeRoot: string, content: string): void {
  const markerPath = path.join(worktreeRoot, WORKTREE_MARKER_REL);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, content, "utf-8");
}

test("[worktree marker] 常量值符合 spec 约定", () => {
  expect(WORKTREE_MARKER_REL).toBe(".loop-engineering/worktree.json");
  expect(WORKTREE_MARKER_SCHEMA).toBe("loop-engineering.worktree-marker.v1");
  expect(WORKTREE_MARKER_OWNER).toBe("loop-engineering");
});

test("[worktree marker] 合法 marker → 解析出全部字段", () => {
  const root = makeTmp();
  writeMarkerRaw(
    root,
    JSON.stringify({
      schema: WORKTREE_MARKER_SCHEMA,
      owner: WORKTREE_MARKER_OWNER,
      run_id: "20260629-001",
      created_at: "2026-06-29T00:00:00.000Z",
    }),
  );

  const marker = readWorktreeMarker(root);
  expect(marker).not.toBeNull();
  expect(marker!.schema).toBe(WORKTREE_MARKER_SCHEMA);
  expect(marker!.owner).toBe(WORKTREE_MARKER_OWNER);
  expect(marker!.run_id).toBe("20260629-001");
  expect(marker!.created_at).toBe("2026-06-29T00:00:00.000Z");
});

test("[worktree marker] marker 文件不存在 → null", () => {
  const root = makeTmp();
  expect(readWorktreeMarker(root)).toBeNull();
});

test("[worktree marker] JSON 损坏 → null (不抛)", () => {
  const root = makeTmp();
  writeMarkerRaw(root, "{ this is not json ");
  expect(readWorktreeMarker(root)).toBeNull();
});

test("[worktree marker] owner 不符 → null", () => {
  const root = makeTmp();
  writeMarkerRaw(
    root,
    JSON.stringify({
      schema: WORKTREE_MARKER_SCHEMA,
      owner: "someone-else",
      run_id: "20260629-001",
      created_at: "2026-06-29T00:00:00.000Z",
    }),
  );
  expect(readWorktreeMarker(root)).toBeNull();
});

test("[worktree marker] schema 不符 → null", () => {
  const root = makeTmp();
  writeMarkerRaw(
    root,
    JSON.stringify({
      schema: "wrong-schema",
      owner: WORKTREE_MARKER_OWNER,
      run_id: "20260629-001",
      created_at: "2026-06-29T00:00:00.000Z",
    }),
  );
  expect(readWorktreeMarker(root)).toBeNull();
});

test("[worktree marker] 缺 run_id 字段 → null", () => {
  const root = makeTmp();
  writeMarkerRaw(
    root,
    JSON.stringify({
      schema: WORKTREE_MARKER_SCHEMA,
      owner: WORKTREE_MARKER_OWNER,
      created_at: "2026-06-29T00:00:00.000Z",
    }),
  );
  expect(readWorktreeMarker(root)).toBeNull();
});

test("[worktree marker] 缺 created_at 字段 → null", () => {
  const root = makeTmp();
  writeMarkerRaw(
    root,
    JSON.stringify({
      schema: WORKTREE_MARKER_SCHEMA,
      owner: WORKTREE_MARKER_OWNER,
      run_id: "20260629-001",
    }),
  );
  expect(readWorktreeMarker(root)).toBeNull();
});

test("[worktree marker] isInLoopWorktree: 合法 marker → true", () => {
  const root = makeTmp();
  writeMarkerRaw(
    root,
    JSON.stringify({
      schema: WORKTREE_MARKER_SCHEMA,
      owner: WORKTREE_MARKER_OWNER,
      run_id: "20260629-002",
      created_at: "2026-06-29T00:00:00.000Z",
    }),
  );
  expect(isInLoopWorktree(root)).toBe(true);
});

test("[worktree marker] isInLoopWorktree: 无 marker → false", () => {
  const root = makeTmp();
  expect(isInLoopWorktree(root)).toBe(false);
});

test("[worktree marker] isInLoopWorktree: marker 损坏 → false", () => {
  const root = makeTmp();
  writeMarkerRaw(root, "not json");
  expect(isInLoopWorktree(root)).toBe(false);
});
