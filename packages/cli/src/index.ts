#!/usr/bin/env node
/**
 * e2e-loop CLI 入口。
 *
 * 子命令树:
 *   e2e-loop install    --host <cc|oc|both> --project-dir <path> [--force] [--dry-run]
 *   e2e-loop uninstall  --host <cc|oc|both> --project-dir <path>
 *   e2e-loop list                           --project-dir <path>
 *   e2e-loop help | --help | -h | (无参数)
 *
 * 设计要点:
 *   - 不引第三方 (用 Node 20+ 内置 util.parseArgs)
 *   - 错误 → stderr + exit 1; 成功 → 简洁 stdout
 *   - host=cc → Claude Code; host=oc → OpenCode; host=both → 两套都装 (P2-B 接通)
 *   - 跨平台 (path.join, 不拼 shell 字符串)
 */

import { parseCliArgs, ArgParseError } from "./args.js";
import { printHelp } from "./commands/help.js";
import { runInstall } from "./commands/install.js";
import { runUninstall } from "./commands/uninstall.js";
import { runList } from "./commands/list.js";
import { runHook } from "./commands/hook.js";
import {
  runInit,
  runStatus,
  runPlan,
  runRun,
  runWrapUp,
  runSignoffPlan,
  runSignoffWrapUp,
  runAbort,
  runAmend,
} from "./commands/dryrun.js";
import { InvalidHostError } from "./util.js";

/**
 * dry-run 子命令统一守卫: 捕获 Coordinator/runtime 抛出的运行期错误,
 * 写友好信息到 stderr 并返回 1 (对齐 CLI "错误 → stderr + exit 1" 风格)。
 *
 * 命令函数自身的"参数缺失/文件不存在"已在内部返回 2; 这里只兜运行期 throw。
 */
function dryRunGuard(fn: () => number): number {
  try {
    return fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`错误: ${msg}\n`);
    return 1;
  }
}

async function main(): Promise<number> {
  const tokens = process.argv.slice(2);

  // 无参数 → 显示 help, exit 1 (用户没指定要做什么, 提示一下)
  if (tokens.length === 0) {
    printHelp(process.stdout);
    return 1;
  }

  let args;
  try {
    args = parseCliArgs(tokens);
  } catch (e) {
    if (e instanceof ArgParseError) {
      process.stderr.write(`错误: ${e.message}\n\n`);
      printHelp(process.stderr);
      return 1;
    }
    throw e;
  }

  // 全局 --help / -h / help 子命令
  if (
    args.command === "help" ||
    args.flags.has("help") ||
    args.flags.has("h")
  ) {
    printHelp(process.stdout);
    return 0;
  }

  switch (args.command) {
    // --- 安装类 (P1~P3) ---
    case "install":
      return await runInstall(args);
    case "uninstall":
      return await runUninstall(args);
    case "list":
      return await runList(args);
    case "hook":
      return await runHook(args);
    // --- 算法 dry-run 类 (P5-M7B, 同步, 对齐 Python cli.py) ---
    // 这些命令调 Coordinator, 可能抛运行期错误 (如 run-state 缺失、收口 gate 未过的签收拒绝)。
    // 统一在 dryRunGuard 内捕获, 友好 stderr + exit 1, 不抛裸 stack。
    case "init":
      return dryRunGuard(() => runInit(args));
    case "status":
      return dryRunGuard(() => runStatus(args));
    case "plan":
      return dryRunGuard(() => runPlan(args));
    case "run":
      return dryRunGuard(() => runRun(args));
    case "wrap-up":
      return dryRunGuard(() => runWrapUp(args));
    case "signoff-plan":
      return dryRunGuard(() => runSignoffPlan(args));
    case "signoff-wrap-up":
      return dryRunGuard(() => runSignoffWrapUp(args));
    case "abort":
      return dryRunGuard(() => runAbort(args));
    case "amend":
      return dryRunGuard(() => runAmend(args));
    case undefined:
      process.stderr.write("错误: 缺少子命令\n\n");
      printHelp(process.stderr);
      return 1;
    default:
      process.stderr.write(`错误: 未知子命令 "${args.command}"\n\n`);
      printHelp(process.stderr);
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    // 已知业务错误 → 友好 stderr + exit 1
    if (e instanceof InvalidHostError) {
      process.stderr.write(`错误: ${e.message}\n`);
      process.exitCode = 1;
      return;
    }
    // 未知错误 → 完整 stack, 方便调试
    const msg = e instanceof Error ? e.stack ?? e.message : String(e);
    process.stderr.write(`致命错误:\n${msg}\n`);
    process.exitCode = 1;
  });
