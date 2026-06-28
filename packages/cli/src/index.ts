#!/usr/bin/env node
/**
 * e2e-loop CLI 入口。
 *
 * 子命令树:
 *   e2e-loop install    --host <cc|oc|both> --project-dir <path> [--force] [--dry-run]
 *   e2e-loop uninstall  --host <cc|oc>      --project-dir <path>
 *   e2e-loop list                           --project-dir <path>
 *   e2e-loop help | --help | -h | (无参数)
 *
 * 设计要点:
 *   - 不引第三方 (用 Node 20+ 内置 util.parseArgs)
 *   - 错误 → stderr + exit 1; 成功 → 简洁 stdout
 *   - host=oc/both 在 P1 阶段显式失败 (协作范式红线)
 *   - 跨平台 (path.join, 不拼 shell 字符串)
 */

import { parseCliArgs, ArgParseError } from "./args.js";
import { printHelp } from "./commands/help.js";
import { runInstall } from "./commands/install.js";
import { runUninstall } from "./commands/uninstall.js";
import { runList } from "./commands/list.js";
import {
  InvalidHostError,
  OcNotImplementedError,
  BothNotImplementedError,
} from "./util.js";

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
    case "install":
      return await runInstall(args);
    case "uninstall":
      return await runUninstall(args);
    case "list":
      return await runList(args);
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
    if (
      e instanceof InvalidHostError ||
      e instanceof OcNotImplementedError ||
      e instanceof BothNotImplementedError
    ) {
      process.stderr.write(`错误: ${e.message}\n`);
      process.exitCode = 1;
      return;
    }
    // 未知错误 → 完整 stack, 方便调试
    const msg = e instanceof Error ? e.stack ?? e.message : String(e);
    process.stderr.write(`致命错误:\n${msg}\n`);
    process.exitCode = 1;
  });
