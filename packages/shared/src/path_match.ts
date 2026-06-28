/**
 * 路径匹配: glob + 前缀匹配混合策略。
 *
 * 规范源: docs/loop-engineering-cross-host-design.md §8.5.2 (guard_paths 用)。
 *
 * 匹配规则 (与 Python `scheduling/path_overlap.py` 等价):
 * - `**` 跨多层目录 (含 0 层)
 * - `*` 匹配单层目录内的任意字符 (不含路径分隔符)
 * - 无通配符时退化为前缀匹配 (startsWith)
 * - 比较前统一规范化分隔符 (Windows `\` → `/`)
 *
 * 用例 (见文件底部注释)。
 */

/**
 * 规范化路径分隔符: Windows 反斜杠转正斜杠。
 * 不做 case 折叠 (Linux 大小写敏感); Windows 由上层调用方决定是否额外 lower-case。
 */
export function normalizePath(p: string): string {
  if (!p) return p;
  // 把所有反斜杠替换为正斜杠, 不动其它字符
  return p.replace(/\\/g, "/");
}

/**
 * 把 glob pattern 翻译为正则。
 *
 * - `**` → `.*` (跨多层目录)
 * - `*` → `[^/]*` (单层, 不含分隔符)
 * - 其它字符按字面量转义
 *
 * 仅做字面量 + 通配符替换, 不支持 `?`、字符集 `[...]`、`{a,b}` 等; 这是 Python 端
 * actual_writes/path_overlap 一直在用的极简子集。
 */
function globToRegExp(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i += 2;
      // 允许 `**/` 后跟路径分隔符直接消费
      if (pattern[i] === "/") i += 1;
    } else if (ch === "*") {
      re += "[^/]*";
      i += 1;
    } else {
      // 转义正则元字符
      re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  // 锚定整条路径, 不再追加 `(?:/.*)?` 尾后缀。
  //
  // 该尾后缀原意是"目录缩写下其文件也算命中", 但它会让以单 `*` 结尾的模式错误跨层:
  //   `src/*` → `^src/[^/]*(?:/.*)?$` 会命中 `src/foo/bar.py` (`[^/]*`=foo, 后缀吃掉 `/bar.py`),
  // 与 Python `path_overlap.py` "`*` 不跨 `/`" 的约定相悖。
  // 跨层语义只应由 `**` (→ `.*`) 表达; 无通配的目录前缀走上层 startsWith 分支, 不经此函数。
  return new RegExp(`^${re}$`);
}

/**
 * 匹配路径。
 *
 * @param pattern glob pattern, 例如 `src/**`、`.claude/**` 或无通配符的目录前缀
 * @param path 待匹配路径 (绝对或相对均可, 但与 pattern 应在同一坐标系)
 * @returns 是否匹配
 */
export function matchPath(pattern: string, path: string): boolean {
  const np = normalizePath(pattern);
  const npath = normalizePath(path);

  // 无通配符 → 前缀匹配 (与 path_overlap.py 等价)
  if (!/[*?]/.test(np)) {
    if (np === "") return true;
    if (npath === np) return true;
    return npath.startsWith(np.endsWith("/") ? np : np + "/");
  }

  // 含通配符 → 正则匹配
  return globToRegExp(np).test(npath);
}

/*
 * 用例 (用于人工 review 时回归):
 *
 *   matchPath("src/**", "src/foo/bar.py")        // true  (跨多层)
 *   matchPath("src/**", "src/foo.py")            // true  (含 0 层)
 *   matchPath("src/**", "docs/x.md")             // false (前缀不符)
 *   matchPath(".claude/**", ".claude/x")         // true
 *   matchPath(".claude/**", ".claude\\x")        // true  (Windows 反斜杠)
 *   matchPath("src/*", "src/foo.py")             // true  (单层)
 *   matchPath("src/*", "src/foo/bar.py")         // false (* 不跨层)
 *   matchPath("src", "src/foo/bar.py")           // true  (无通配符, 前缀)
 *   matchPath("src", "src")                      // true  (完全相等)
 *   matchPath("src", "srcfile.txt")              // false (前缀必须按目录边界)
 */
