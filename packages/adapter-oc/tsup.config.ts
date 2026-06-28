/**
 * adapter-oc 的构建配置。
 *
 * 1. 把 src/index.ts bundle 成 dist/index.mjs, 作为 @e2e-loop/adapter-opencode 的
 *    HostAdapter API 包入口。
 * 2. 把 src/plugin/index.ts 连同 @e2e-loop/shared (及其它非 node 内置依赖) bundle 成
 * **自包含单文件** dist/loop-engineering.js:
 *   - format esm, platform node, target node18 (OC 跑在 Bun, 兼容 node18+ ESM)。
 *   - noExternal 全打进 (含 @e2e-loop/shared + js-yaml 等), 落到目标项目
 *     .opencode/plugins/loop-engineering.js 后无需 node_modules 即可被 OC 加载。
 *   - 保留命名导出 LoopEngineeringPlugin (OC local plugin 靠命名导出发现工厂)。
 *
 * 与 adapter-cc/tsup.config.ts 的差异:
 *   - adapter-cc 产 4 个 hook .mjs (CC stdin/stdout 形态); 本配置额外产 1 个 plugin .js (OC plugin 形态)。
 *   - plugin 输出扩展名用 .js (OC 文档示例用 .js/.ts; .js 更通用), 不是 .mjs。
 *   - @opencode-ai/plugin 仅类型, plugin 源码用 import type / 自写最小类型, 不进 bundle。
 *
 * 两类产物不能混用: CLI import 包入口需要 opencodeAdapter, OpenCode 加载 plugin bundle
 * 需要 LoopEngineeringPlugin。
 */

import { defineConfig } from "tsup";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig([
  {
    entry: {
      index: path.join(here, "src/index.ts"),
    },
    outDir: path.join(here, "dist"),
    format: ["esm"],
    outExtension: () => ({ js: ".mjs" }),
    target: "node18",
    platform: "node",
    noExternal: [/.*/],
    external: [],
    splitting: false,
    sourcemap: false,
    clean: false,
  },
  {
    entry: {
      "loop-engineering": path.join(here, "src/plugin/index.ts"),
    },
    outDir: path.join(here, "dist"),
    format: ["esm"],
    outExtension: () => ({ js: ".js" }),
    target: "node18",
    platform: "node",
    // 自包含: 把 @e2e-loop/shared 与 js-yaml 等所有非 node 内置依赖打进单文件。
    noExternal: [/.*/],
    // node 内置模块保持外部 import (fs / path / child_process 等)。
    external: [],
    splitting: false,
    sourcemap: false,
    clean: false,
    // 保留命名导出 LoopEngineeringPlugin (ESM, OC 命名导出发现工厂)。
    banner: {
      js: "/* loop-engineering OpenCode plugin (auto-generated; do not edit) */",
    },
  },
]);
