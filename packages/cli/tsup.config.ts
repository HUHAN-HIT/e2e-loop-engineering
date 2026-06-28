/**
 * CLI 构建配置。
 *
 * 把 src/index.ts bundle 成单文件 dist/index.mjs:
 *   - bundle workspace 依赖 (@e2e-loop/shared + @e2e-loop/adapter-claude-code)
 *   - target node20, format esm, platform node
 *   - shebang 由源文件 src/index.ts 首行自带 (tsup 会原样保留), 用户可直接
 *     ./dist/index.mjs 或 npm install -g; 这里不再用 banner 注入, 否则会出现
 *     两行 shebang —— Node 只忽略首行, 第二行被当代码导致 SyntaxError。
 *
 * 注意: adapter-cc 的 4 个 hook .mjs 是 install 时从 packages/adapter-cc/dist/ 读取并
 * 复制到目标项目的, 不打包进 CLI bundle; 所以构建 CLI 前应先构建 adapter-cc
 * (npm run build:adapter-cc)。
 */

import { defineConfig } from "tsup";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: { index: path.join(here, "src/index.ts") },
  outDir: path.join(here, "dist"),
  format: ["esm"],
  outExtension: () => ({ js: ".mjs" }),
  target: "node20",
  platform: "node",
  // 自包含: 把 @e2e-loop/shared 与 @e2e-loop/adapter-claude-code 的源码打进单文件
  noExternal: [/@e2e-loop\//],
  // node 内置模块保持外部 import
  external: [],
  splitting: false,
  sourcemap: false,
  clean: true,
  // 不注入 banner: shebang 已由 src/index.ts 首行提供, 避免重复 shebang 报错。
});
