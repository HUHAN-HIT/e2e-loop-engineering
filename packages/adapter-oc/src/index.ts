/**
 * OpenCode adapter 包入口。
 *
 * 导出 opencodeAdapter 单例 (实现 HostAdapter) + frontmatter/config 渲染辅助。
 * OpenCode 不装 hooks (无 .mjs binding), 因此本包不依赖 adapter-cc。
 */

export { opencodeAdapter, collectManifestEntries, repoRoot } from "./install.js";
export {
  renderOpencodeAgent,
  defaultOpencodeConfig,
  mergeOpencodeConfig,
} from "./render.js";
