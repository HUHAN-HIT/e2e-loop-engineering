/**
 * e2e-loop install 子命令。
 *
 * 用法:
 *   e2e-loop install --host <cc|oc|both> --project-dir <path> [--force] [--dry-run]
 *
 * 行为:
 *   - host=cc:   调 claudeCodeAdapter.install(ctx) / dryRun(ctx)
 *   - host=oc:   调 opencodeAdapter.install(ctx) / dryRun(ctx) (与 cc 同构输出)
 *   - host=both: 依次跑 CC 与 OC 两个 adapter, 合并输出并标注每个文件来自哪个宿主
 *   - --dry-run: 只调 dryRun, 输出预览不写盘
 *   - --force:   覆盖已存在文件
 *
 * both 模式合并策略 (规范源: docs/loop-engineering-cross-host-design.md §7):
 *   两宿主共享 `.claude/skills/loop-engineering/` 下的 SKILL.md / standards / README,
 *   即同一份文件。先跑的 adapter 写入, 后跑的 adapter 在 force=false 时这些会进 skipped,
 *   在 force=true 时被同内容覆盖——这是【预期】, 不算错。输出按宿主分段, 每个文件前缀
 *   [cc] / [oc] 标注来源, 让用户看清哪套资产由谁落盘。
 */

import type { Args } from "../args.js";
import type { HostAdapter, InstallContext } from "@e2e-loop/shared";
import { claudeCodeAdapter } from "@e2e-loop/adapter-claude-code";
import { opencodeAdapter } from "@e2e-loop/adapter-opencode";
import { resolveProjectDir } from "../util.js";

/** 跑单个 adapter 的 dryRun 并把预览写到 stdout (host=both 时带宿主标签前缀)。 */
async function previewOne(
  adapter: HostAdapter,
  ctx: InstallContext,
  label: string | null,
): Promise<void> {
  const tag = label ? `[${label}] ` : "";
  const manifest = await adapter.dryRun(ctx);
  process.stdout.write(
    `${tag}[dry-run] 计划落盘 ${manifest.files.length} 个文件到 ${ctx.projectDir}\n`,
  );
  for (const f of manifest.files) {
    process.stdout.write(
      `  ${tag}${f.source.padEnd(8)} ${String(f.size).padStart(8)}B  ${f.path}\n`,
    );
  }
  if (manifest.conflictFiles.length > 0) {
    process.stdout.write(
      `\n${tag}冲突文件 (force=false 时会跳过): ${manifest.conflictFiles.length} 个\n`,
    );
    for (const c of manifest.conflictFiles) {
      process.stdout.write(`  ${tag}! ${c}\n`);
    }
  }
}

/** 跑单个 adapter 的 install 并把结果写到 stdout (host=both 时带宿主标签前缀)。 */
async function installOne(
  adapter: HostAdapter,
  ctx: InstallContext,
  label: string | null,
): Promise<void> {
  const tag = label ? `[${label}] ` : "";
  const result = await adapter.install(ctx);
  process.stdout.write(
    `${tag}install 完成: installed ${result.writtenFiles.length}, skipped ${result.skippedFiles.length}\n`,
  );
  for (const f of result.writtenFiles) {
    process.stdout.write(`  ${tag}+ ${f}\n`);
  }
  for (const f of result.skippedFiles) {
    process.stdout.write(`  ${tag}~ ${f} (跳过)\n`);
  }
  if (result.writtenFiles.length === 0 && result.skippedFiles.length > 0) {
    process.stdout.write(
      `\n${tag}提示: 所有文件都已存在; 用 --force 覆盖。\n`,
    );
  }
}

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
  const hookModeValue = args.values["hook-mode"];
  const hookMode = hookModeValue as InstallContext["hookMode"];
  if (
    hookModeValue &&
    hookModeValue !== "local" &&
    hookModeValue !== "cli" &&
    hookModeValue !== "auto"
  ) {
    process.stderr.write(`错误: --hook-mode 只接受 local | cli | auto, 收到: ${hookModeValue}\n`);
    return 1;
  }
  const ctx: InstallContext = {
    projectDir,
    force,
    hookMode,
    cliCommand: args.values["cli-command"],
  };

  // host=both: 依次跑 CC → OC, 输出按宿主分段标注。
  // 顺序固定 CC 先 OC 后: 共享的 .claude/skills/ 由 CC 先写, OC 第二次跑时这些进 skipped
  // (force=false) 或被同内容覆盖 (force=true), 均为预期。
  if (host === "both") {
    if (dryRun) {
      await previewOne(claudeCodeAdapter, ctx, "cc");
      process.stdout.write("\n");
      await previewOne(opencodeAdapter, ctx, "oc");
    } else {
      await installOne(claudeCodeAdapter, ctx, "cc");
      process.stdout.write("\n");
      await installOne(opencodeAdapter, ctx, "oc");
    }
    return 0;
  }

  // host=cc / oc: 单 adapter, 不带宿主标签 (输出格式与 P1 保持兼容)。
  const adapter = host === "cc" ? claudeCodeAdapter : opencodeAdapter;
  if (dryRun) {
    await previewOne(adapter, ctx, null);
  } else {
    await installOne(adapter, ctx, null);
  }
  return 0;
}
