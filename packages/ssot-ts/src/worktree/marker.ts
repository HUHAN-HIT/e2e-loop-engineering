/**
 * Worktree 根 marker 的写入 (spec: 2026-06-29-worktree-only-isolation-design 改动①)。
 *
 * marker 的常量 / 类型 / 读 helper 在 shared (`@e2e-loop/shared` 的 worktree_marker),
 * 这里只负责"写": allocator 创建 worktree 后, 在 worktree 根写
 * `.loop-engineering/worktree.json`, 走 atomicReplace (Windows 杀软锁竞态重试), 与
 * binding.ts / directory.ts 的原子写模式一致。
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  WORKTREE_MARKER_OWNER,
  WORKTREE_MARKER_REL,
  WORKTREE_MARKER_SCHEMA,
  type WorktreeMarker,
} from "@e2e-loop/shared";

import { atomicReplace } from "../runtime/directory.js";

/**
 * 在 worktree 根写 marker (原子写)。
 *
 * 内容: `{ schema, owner, run_id, created_at: now.toISOString() }`。
 * 同目录 tmp + atomicReplace, 防半写 + 防 Windows 文件锁竞态 (仿 writeWorktreeBinding)。
 */
export function writeWorktreeMarker(worktreeRoot: string, runId: string, now: Date): void {
  const marker: WorktreeMarker = {
    schema: WORKTREE_MARKER_SCHEMA,
    owner: WORKTREE_MARKER_OWNER,
    run_id: runId,
    created_at: now.toISOString(),
  };
  const target = path.join(worktreeRoot, WORKTREE_MARKER_REL);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.worktree-marker-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.tmp`,
  );
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(marker, null, 2)}\n`, "utf-8");
    atomicReplace(tmpPath, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}
