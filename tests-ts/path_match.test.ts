/**
 * path_match 等价测试 (P1 go/no-go 门禁)。
 *
 * 行为权威: Python `tests/test_path_overlap.py` + `loop_engineering/scheduling/path_overlap.py`。
 * 被测实现: `packages/shared/src/path_match.ts` (matchPath / normalizePath)。
 *
 * ── 两套函数的契约映射 (关键, 必读) ──────────────────────────────────────────
 * Python 端权威函数是 `path_globs_overlap(globs_a, globs_b)`: glob 列表 ↔ glob 列表的
 * **对称重叠**判定 (plan 阶段两个 task 写路径是否冲突), 判不准时**保守返回 True** (默认串行)。
 *
 * TS 端 `matchPath(pattern, path)` 是 **单向**判定: "一条具体路径 path 是否落在 glob pattern 内"。
 * 这是 guard_paths / 越界检测里实际用法 —— actual_writes 永远是 git/fs 采集的**具体文件路径**,
 * 不是 glob, 故 TS 用单向 matchPath 而非对称 overlap (见 actual_writes.ts checkBoundary)。
 *
 * 因此移植策略:
 *  A) 当 Python 用例的第二个 glob 是**具体路径**时, `path_globs_overlap([P],[concrete])`
 *     语义上等价于 `matchPath(P, concrete)` —— 逐条断言 TS 给出与 Python 相同结果。
 *  B) 当两边都是 glob (如 `*.py` vs `**`、`a/**` vs `a`)、或含 Python "保守 True" 语法
 *     (`!` / `[...]` / `{...}`) 时, 超出 matchPath 的 pattern×path 契约。这些归入
 *     "契约差异" 分组: 断言 matchPath 的**真实单向语义**, 并在注释说明它与 Python
 *     对称-保守语义的分歧 (非 bug, TS 使用场景不会触发)。
 *
 * Python 用例名以 `[py: <name>]` 标注, 便于回溯。
 */
import { test, expect } from "bun:test";
import { matchPath, normalizePath } from "@e2e-loop/shared";

// ───────────────────────────────────────────────────────────────────────────
// A) 可 1:1 对应的用例 (Python 第二参为具体路径 → matchPath(P, concrete))
// ───────────────────────────────────────────────────────────────────────────

test("[py: test_recursive_includes_nested] a/** 命中 a/b.py (前缀包含)", () => {
  // path_globs_overlap(["a/**"], ["a/b.py"]) is True
  expect(matchPath("a/**", "a/b.py")).toBe(true);
});

test("[py: test_star_does_not_cross_slash] a/*.py 不命中 a/b/c.py (* 不跨 /)", () => {
  // path_globs_overlap(["a/*.py"], ["a/b/c.py"]) is False —— 核心: 单 * 不跨层
  expect(matchPath("a/*.py", "a/b/c.py")).toBe(false);
});

test("[py: test_double_star_crosses_slash] a/** 命中 a/b/c/d.py (深层递归)", () => {
  // path_globs_overlap(["a/**"], ["a/b/c/d.py"]) is True
  expect(matchPath("a/**", "a/b/c/d.py")).toBe(true);
});

test("[py: test_exact_path_match] a/b.py 命中 a/b.py (完全相等)", () => {
  // path_globs_overlap(["a/b.py"], ["a/b.py"]) is True (无通配 → 前缀/相等)
  expect(matchPath("a/b.py", "a/b.py")).toBe(true);
});

test("[py: test_directory_glob_expands] a (无尾 /) 命中 a/b.py (目录缩写)", () => {
  // path_globs_overlap(["a"], ["a/b.py"]) is True —— 无通配前缀按目录边界命中其下文件
  expect(matchPath("a", "a/b.py")).toBe(true);
});

test("[py: test_double_star_middle] a/**/b.py 命中 a/b.py (** 含 0 层)", () => {
  // path_globs_overlap(["a/**/b.py"], ["a/b.py"]) is True
  expect(matchPath("a/**/b.py", "a/b.py")).toBe(true);
});

test("[py: test_double_star_middle] a/**/b.py 命中 a/x/b.py (** 跨 1 层)", () => {
  // path_globs_overlap(["a/**/b.py"], ["a/x/b.py"]) is True
  expect(matchPath("a/**/b.py", "a/x/b.py")).toBe(true);
});

// 来自 path_match.ts 文件底部自带用例 (与 Python "* 单层 / 前缀按目录边界" 约定同源)
test("[ts-doc] src/** 命中 src/foo/bar.py (跨多层)", () => {
  expect(matchPath("src/**", "src/foo/bar.py")).toBe(true);
});

test("[ts-doc] src/** 命中 src/foo.py (** 含 0 层)", () => {
  expect(matchPath("src/**", "src/foo.py")).toBe(true);
});

test("[ts-doc] src/** 不命中 docs/x.md (不同根, 前缀不符)", () => {
  expect(matchPath("src/**", "docs/x.md")).toBe(false);
});

test("[ts-doc] src/* 命中 src/foo.py (单层)", () => {
  expect(matchPath("src/*", "src/foo.py")).toBe(true);
});

test("[ts-doc][回归修复] src/* 不命中 src/foo/bar.py (* 不跨层)", () => {
  // 这条曾经因 globToRegExp 尾部 `(?:/.*)?` 后缀错误返回 true (跨层);
  // 已对齐 Python "* 不跨 /" 约定修复。详见简报。
  expect(matchPath("src/*", "src/foo/bar.py")).toBe(false);
});

test("[ts-doc] src 命中 src/foo/bar.py (无通配前缀)", () => {
  expect(matchPath("src", "src/foo/bar.py")).toBe(true);
});

test("[ts-doc] src 命中 src (完全相等)", () => {
  expect(matchPath("src", "src")).toBe(true);
});

test("[ts-doc] src 不命中 srcfile.txt (前缀必须按目录边界)", () => {
  // 前缀匹配按 `/` 边界, 不是裸 startsWith, 故 srcfile.txt 不算 src 下
  expect(matchPath("src", "srcfile.txt")).toBe(false);
});

// ───────────────────────────────────────────────────────────────────────────
// 边界: 尾随斜杠 / 绝对路径 / 单层 * / 纯 *.py 文件名
// ───────────────────────────────────────────────────────────────────────────

test("[边界] 尾随斜杠 src/ 命中 src/foo.py", () => {
  // 无通配前缀以 / 结尾时直接 startsWith(np)
  expect(matchPath("src/", "src/foo.py")).toBe(true);
});

test("[边界] *.py 命中同层 x.py", () => {
  expect(matchPath("*.py", "x.py")).toBe(true);
});

test("[边界] *.py 不命中 a/x.py (* 不跨层)", () => {
  expect(matchPath("*.py", "a/x.py")).toBe(false);
});

test("[边界] 空 pattern 命中任意路径 (空前缀)", () => {
  // matchPath 无通配分支: np === "" → true
  expect(matchPath("", "anything/here.py")).toBe(true);
});

test("[边界] 绝对路径前缀: /abs/src 命中 /abs/src/x.py", () => {
  expect(matchPath("/abs/src", "/abs/src/x.py")).toBe(true);
});

test("[边界] 绝对路径前缀: /abs/src 不命中 /abs/srcfile.py", () => {
  expect(matchPath("/abs/src", "/abs/srcfile.py")).toBe(false);
});

// ───────────────────────────────────────────────────────────────────────────
// Windows 反斜杠归一化 (normalizePath)
// ───────────────────────────────────────────────────────────────────────────

const BS = String.fromCharCode(92); // 反斜杠字面量, 规避源码转义

test("[Windows] normalizePath 把反斜杠转正斜杠", () => {
  expect(normalizePath("a" + BS + "b" + BS + "c.py")).toBe("a/b/c.py");
});

test("[Windows] normalizePath 空串原样返回", () => {
  expect(normalizePath("")).toBe("");
});

test("[Windows] .claude/** 命中反斜杠路径 .claude\\x (归一化后匹配)", () => {
  // 与 path_match.ts 文件底部用例一致: pattern/path 比较前统一归一化分隔符
  expect(matchPath(".claude/**", ".claude" + BS + "x")).toBe(true);
});

test("[Windows] src/** 命中混用分隔符 src\\foo\\bar.py", () => {
  expect(matchPath("src/**", "src" + BS + "foo" + BS + "bar.py")).toBe(true);
});

test("[Windows] pattern 用反斜杠 src\\* 命中 src/foo.py (pattern 也归一化)", () => {
  expect(matchPath("src" + BS + "*", "src/foo.py")).toBe(true);
});

// ───────────────────────────────────────────────────────────────────────────
// B) 契约差异分组: Python path_globs_overlap 对称-保守语义 vs TS matchPath 单向语义
//
// 这些用例 Python 期望 True (glob×glob 重叠或"判不准保守串行"), 但 matchPath 是
// pattern×具体路径 的单向匹配, 不承担 plan 阶段的保守职责。TS 越界检测的 actual_writes
// 都是具体文件路径, 不会出现 ! / [...] / {...} / 裸目录名作为待判路径, 故此分歧不会被触发。
// 这里断言 matchPath 的**真实单向行为**, 锁定其契约边界 (防回归), 而非 Python 的 True。
// ───────────────────────────────────────────────────────────────────────────

test("[契约差异][py: test_negation_pattern] matchPath(!secret/**, public/x.py)=false", () => {
  // Python path_globs_overlap 对含 `!` 的 glob 保守返回 True;
  // matchPath 把 `!secret/**` 当字面量模式, public/x.py 当然不匹配 → false。
  expect(matchPath("!secret/**", "public/x.py")).toBe(false);
});

test("[契约差异][py: test_unknown_syntax] matchPath(src/[abc]/x.py, src/b/x.py)=false", () => {
  // Python 对 `[` 字符类保守 True; matchPath 把 `[abc]` 转义成字面量, 不匹配 src/b/x.py → false。
  expect(matchPath("src/[abc]/x.py", "src/b/x.py")).toBe(false);
});

test("[契约差异][py: test_brace_expansion] matchPath(src/{a,b}/x.py, src/a/x.py)=false", () => {
  // Python 对 `{a,b}` brace 保守 True; matchPath 把 `{a,b}` 转义成字面量 → false。
  expect(matchPath("src/{a,b}/x.py", "src/a/x.py")).toBe(false);
});

test("[契约差异][py: test_glob_at_end] matchPath(a/**, a)=false (单向, a 非 a/** 下文件)", () => {
  // Python path_globs_overlap(["a/**"], ["a"]) is True (对称: 递归覆盖目录缩写本身);
  // matchPath 方向是"a 是否匹配 a/**" —— a/** 翻译为 ^a/.*$, 不含目录 a 本身 → false。
  expect(matchPath("a/**", "a")).toBe(false);
});

test("[契约差异][py: test_disjoint_paths] matchPath(a/**, b/**)=false (不同根, 与 Python 同为 False)", () => {
  // 此条 Python 也是 False, 方向无歧义, 顺带覆盖。
  expect(matchPath("a/**", "b/**")).toBe(false);
});
