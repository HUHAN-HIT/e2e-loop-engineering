/**
 * run-level worktree binding artifact.
 *
 * `worktree-binding.json` 是 run 与真实代码工作目录的审计入口。旧 run 没有该文件时,
 * 调用方必须保留 legacy `dirname(runDir)` 推导, 不能因为缺 binding 中断。
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { z } from "zod";

export const WORKTREE_BINDING_SCHEMA = "loop-engineering.worktree-binding.v1";
export const WORKTREE_BINDING_OWNER = "loop-engineering";

export const WorktreeBindingModeSchema = z.enum([
  "none",
  "existing",
  "created",
  "adopted",
]);
export type WorktreeBindingMode = z.infer<typeof WorktreeBindingModeSchema>;

export const WorktreeBindingStatusSchema = z.enum([
  "active",
  "kept",
  "cleaned",
  "cleanup_failed",
]);
export type WorktreeBindingStatus = z.infer<typeof WorktreeBindingStatusSchema>;

export const WorktreeBindingSchema = z.object({
  schema: z.literal(WORKTREE_BINDING_SCHEMA),
  mode: WorktreeBindingModeSchema,
  owner: z.string(),
  repo_root: z.string(),
  worktree_path: z.string(),
  branch: z.string().nullable(),
  base_ref: z.string(),
  created_at: z.string(),
  managed: z.boolean(),
  status: WorktreeBindingStatusSchema,
});
export type WorktreeBinding = z.infer<typeof WorktreeBindingSchema>;

export function worktreeBindingPath(runDir: string): string {
  return path.join(runDir, "worktree-binding.json");
}

export function parseWorktreeBinding(data: unknown): WorktreeBinding {
  try {
    return WorktreeBindingSchema.parse(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`worktree-binding.json 解析失败: ${msg}`);
  }
}

export function readWorktreeBinding(filePath: string): WorktreeBinding {
  const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
  return parseWorktreeBinding(data);
}

export function readWorktreeBindingOrNull(runDir: string): WorktreeBinding | null {
  const filePath = worktreeBindingPath(runDir);
  if (!fs.existsSync(filePath)) return null;
  return readWorktreeBinding(filePath);
}

export function writeWorktreeBinding(filePath: string, binding: WorktreeBinding): void {
  const validated = parseWorktreeBinding(binding);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.worktree-binding-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.tmp`,
  );
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(validated, null, 2)}\n`, "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}
