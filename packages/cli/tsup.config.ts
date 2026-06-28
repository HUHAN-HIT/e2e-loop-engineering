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
 * 注意 1: adapter-cc 的 4 个 hook .mjs 是 install 时从 packages/adapter-cc/dist/ 读取并
 * 复制到目标项目的, 不打包进 CLI bundle; 所以构建 CLI 前应先构建 adapter-cc
 * (npm run build:adapter-cc)。
 *
 * 注意 2: adapter-oc (host=oc/both) 在 install 时用 js-yaml 渲染 OpenCode agent 的
 * frontmatter (见 packages/adapter-oc/src/render.ts)。adapter-oc 本身无独立 dist, 其 src 被
 * 本配置 noExternal 打进 CLI bundle; 因此 js-yaml 也必须一并 bundle, 否则
 * `node cli/dist/index.mjs install --host oc` 独立运行会因找不到 js-yaml 而报错。
 *
 * 注意 3: P5-M7B 的 dry-run 子命令接 @e2e-loop/ssot, 而 ssot 的 schema 层用了 zod。
 * @e2e-loop/* 已被 noExternal 打进 bundle, 但其传递依赖 zod 默认仍被当外部 import;
 * 为让 `node cli/dist/index.mjs init ...` 独立可跑 (无需在 cli/dist 旁装 node_modules),
 * 必须把 zod 也一并 bundle 进单文件。
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
  // 自包含: 把 @e2e-loop/* (shared / adapter-claude-code / adapter-opencode / ssot) 的源码打进单文件;
  // 同时把 js-yaml 与 zod 一并打进去:
  //   - js-yaml: adapter-oc 渲染 OC agent frontmatter + ssot runtime 读写 task-plan.yaml 时依赖。
  //   - zod:     ssot schema 层的运行期校验依赖 (dry-run 子命令经 @e2e-loop/ssot 传递引入)。
  // bundle 后独立运行需要它们都在场。
  noExternal: [/@e2e-loop\//, "js-yaml", "zod"],
  // node 内置模块保持外部 import
  external: [],
  splitting: false,
  sourcemap: false,
  clean: true,
  // 不注入 banner: shebang 已由 src/index.ts 首行提供, 避免重复 shebang 报错。
});
