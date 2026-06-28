/**
 * Claude Code adapter 包入口。
 *
 * 导出 claudeCodeAdapter 单例 (实现 HostAdapter) + 运行时辅助。
 * 4 个 hook binding 入口 (hooks/*.ts) 由 tsup 直接编译为 .mjs, 不必从此处 re-export,
 * 但本入口需要被 import 才能触发 binding 文件被 tsc 类型检查 (已通过 tsconfig include)。
 */

export { claudeCodeAdapter } from "./install.js";
export {
  HOOK_NAMES,
  collectManifestEntries,
  mergeHooks,
  adapterRoot,
  repoRoot,
} from "./install.js";
export {
  hookOutputToCCStdout,
  parseStdin,
  readStdin,
  runBinding,
  applySideEffect,
  coerceEvent,
  type CCPayload,
} from "./runtime.js";
