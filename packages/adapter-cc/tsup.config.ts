/**
 * adapter-cc 构建配置。
 *
 * 包入口 index + 4 个 hook binding 各编译成单文件 ESM .mjs, bundle 所有依赖 (含 @e2e-loop/shared)。
 * 用户机器只需 node 即可运行 (无需 Bun / 无需 node_modules)。
 */

import { defineConfig } from "tsup";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: {
    index: path.join(here, "src/index.ts"),
    probe_and_gate: path.join(here, "src/hooks/probe_and_gate.ts"),
    guard_paths: path.join(here, "src/hooks/guard_paths.ts"),
    post_task_collect: path.join(here, "src/hooks/post_task_collect.ts"),
    guard_anchors: path.join(here, "src/hooks/guard_anchors.ts"),
  },
  outDir: path.join(here, "dist"),
  format: ["esm"],
  outExtension: () => ({ js: ".mjs" }),
  target: "node18",
  platform: "node",
  // 自包含: 把 @e2e-loop/shared 与 node 内置之外的所有依赖打进单文件
  noExternal: [/.*/],
  // node 内置模块保持外部 import (fs / path / child_process 等)
  external: [],
  splitting: false,
  sourcemap: false,
  clean: true,
  // 顶层 await / ESM: main() 已包在 async 里, shim 不必要, 但保持 banner 让 .mjs 是纯 ESM
  banner: {
    js: "/* loop-engineering Claude Code hook (auto-generated; do not edit) */",
  },
});
