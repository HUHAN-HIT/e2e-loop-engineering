/**
 * e2e-loop install 子命令。
 *
 * 用法:
 *   e2e-loop install --host <cc|oc|both> --project-dir <path> [--force] [--dry-run]
 *
 * 行为:
 *   - host=cc: 调 claudeCodeAdapter.install(ctx) / dryRun(ctx)
 *   - host=oc: stderr 提示 "P2", exit 1
 *   - host=both: stderr 提示 "P2", exit 1
 *   - --dry-run: 只调 dryRun, 输出预览不写盘
 *   - --force: 覆盖已存在文件
 */

import type { Args } from "../args.js";
import { claudeCodeAdapter } from "@e2e-loop/adapter-claude-code";
import {
  resolveProjectDir,
  BothNotImplementedError,
  OcNotImplementedError,
} from "../util.js";

export async function runInstall(args: Args): Promise<number> {
  const host = args.values.host;
  if (!host) {
    process.stderr.write("错误: 缺少必需参数 --host <cc|oc|both>\n");
    return 1;
  }
  if (host !== "cc" && host !== "oc" && host !== "both") {
    process.stderr.write(
      `错误: --host 只接受 cc | oc | both, 收到: ${host}\n`,
    );
    return 1;
  }

  const projectDir = resolveProjectDir(args.values["project-dir"]);
  const force = args.flags.has("force");
  const dryRun = args.flags.has("dry-run");

  // host=oc / both: P1 阶段显式失败 (协作范式红线)
  if (host === "oc") {
    throw new OcNotImplementedError(
      "OC adapter 在 P2 阶段实现 (host=oc 暂不可用)",
    );
  }
  if (host === "both") {
    throw new BothNotImplementedError(
      "both 模式需 P2 完成 (host=both 暂不可用)",
    );
  }

  // 此处 host 只可能是 cc
  const ctx = { projectDir, force };

  if (dryRun) {
    const manifest = await claudeCodeAdapter.dryRun(ctx);
    process.stdout.write(
      `[dry-run] 计划落盘 ${manifest.files.length} 个文件到 ${projectDir}\n`,
    );
    for (const f of manifest.files) {
      process.stdout.write(
        `  ${f.source.padEnd(8)} ${String(f.size).padStart(8)}B  ${f.path}\n`,
      );
    }
    if (manifest.conflictFiles.length > 0) {
      process.stdout.write(
        `\n冲突文件 (force=false 时会跳过): ${manifest.conflictFiles.length} 个\n`,
      );
      for (const c of manifest.conflictFiles) {
        process.stdout.write(`  ! ${c}\n`);
      }
    }
    return 0;
  }

  const result = await claudeCodeAdapter.install(ctx);
  process.stdout.write(
    `install 完成: installed ${result.writtenFiles.length}, skipped ${result.skippedFiles.length}\n`,
  );
  for (const f of result.writtenFiles) {
    process.stdout.write(`  + ${f}\n`);
  }
  for (const f of result.skippedFiles) {
    process.stdout.write(`  ~ ${f} (跳过)\n`);
  }
  if (result.writtenFiles.length === 0 && result.skippedFiles.length > 0) {
    process.stdout.write(
      "\n提示: 所有文件都已存在; 用 --force 覆盖。\n",
    );
  }
  return 0;
}
