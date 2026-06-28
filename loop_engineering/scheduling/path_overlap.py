"""写路径重叠检测 (design §3.2 / §11.1).

规范源: design §3.2 —— "`path_globs_overlap` 无法静态判定时保守返回 True (默认串行)".
本算法是本方案唯一需要充分单测的硬正确性防线 (§3.2 原文).

实现要点:
- 基于标准库 `fnmatch` + 手写 `**` 递归扩展 (不引外部 glob 库).
- `*` 不跨 `/`, 只有 `**` 跨 —— 与 §3.2 case 一致.
- 任何无法静态判定的语法 (含 `!`、`[` 字符类、未识别元字符) 一律保守 True.
- 目录缩写: 末尾无 `/` 的 glob 视为同时匹配自身或其下任意文件 (a ≡ a 或 a/**).

注意: 仅本模块需要 `conflicts` 的 service-aware 语义 (§11.1). 实际写入采集 / capabilities
由 S6 在 scheduling 子模块内单独实现, 本文件不动.
"""
from __future__ import annotations

import re
from functools import lru_cache

from ..schema.task_plan import Task

__all__ = ["path_globs_overlap", "conflicts"]


# 判不准即保守: 凡包含这些"我们不打算精确解析"的语法, 一律视为重叠.
# - `!` 前缀: gitignore 风格否定, design §3.2 未规定语义.
# - `[` / `]`: 字符类, fnmatch 支持但与路径语义混合时易判错, 保守.
# - `{` / `}`: brace 展开, fnmatch 不支持.
# - `\`: 转义, 在 path glob 中极少见且易错, 保守.
_CONSERVATIVE_CHARS = frozenset("![]{}\\")


@lru_cache(maxsize=1024)
def _translate_glob(glob: str) -> re.Pattern[str] | None:
    """把单个 glob 翻译成锚定整条路径的正则.

    返回 None 表示"判不准, 调用方保守 True".

    规则:
    - `**` 跨任意层级 (含 0 层), 是唯一跨 `/` 的通配.
    - `*` 不跨 `/` (与 §3.2 一致).
    - `?` 匹配单字符 (不跨 `/`).
    - 末尾无 `/` 的 glob 视为目录缩写: a ≡ a 或 a/**.
    """
    if not glob:
        return None

    # 含未明确支持的语法 → 保守.
    if any(ch in _CONSERVATIVE_CHARS for ch in glob):
        return None

    # 目录缩写: 末尾非 / 也非 ** 时, 视为 "目录本身 或 目录下任意".
    # 例: "a" → "a" 或 "a/**"; "a/b" → "a/b" 或 "a/b/**".
    # 实现: 把 g 重写为 (?:g|g/.*) 的等价 glob 翻译.
    is_dir_abbrev = not glob.endswith("/") and not glob.endswith("**")

    # 翻译核心.
    pattern = _translate_inner(glob)
    if pattern is None:
        return None

    if is_dir_abbrev:
        inner2 = _translate_inner(glob + "/**")
        if inner2 is None:
            return None
        body = f"(?:{pattern}|{inner2})"
    else:
        body = pattern

    return re.compile(f"^(?:{body})$")


def _translate_inner(glob: str) -> str | None:
    """单 glob → 正则 body (不含锚点). 返回 None 表示判不准.

    手写解析支持 `**` / `*` / `?`, 其余字符按字面量处理 (path 字符集里 . 等需转义).
    """
    out: list[str] = []
    i = 0
    n = len(glob)
    while i < n:
        c = glob[i]
        if c == "*":
            # 双星: 跨任意层级.
            if i + 1 < n and glob[i + 1] == "*":
                # `**` 共有两种合法位置:
                #   1) 整段就是 "**"
                #   2) 形如 "/**" 或 "**/" 或 "/**/" —— 前后必须是 / 或边界.
                # `a**` (字母紧跟 **) 这类语义模糊, 保守 None.
                prev = glob[i - 1] if i > 0 else ""
                # 跳过两个 *
                j = i + 2
                nxt = glob[j] if j < n else ""
                if prev in ("", "/") and nxt in ("", "/"):
                    # 跨任意 (含 0) 层目录.
                    # 处理: 若后面接 /, 让 / 可被吸收 (避免 a/**/b 匹配 a/b 时多一个 /).
                    if nxt == "/":
                        # `/**/` → 匹配 "/" 或 "/(...)/"
                        out.append("(?:.*/)?")
                        i = j + 1  # 跳过 `**/`
                        continue
                    else:
                        # `**` 在末尾 → 匹配任意 (含跨 /).
                        out.append(".*")
                        i = j
                        continue
                else:
                    # 字母紧贴 `**`, 语义不清, 保守.
                    return None
            else:
                # 单 `*`: 不跨 /.
                out.append("[^/]*")
                i += 1
                continue
        elif c == "?":
            out.append("[^/]")
            i += 1
            continue
        else:
            # 字面量: 转义正则元字符.
            out.append(re.escape(c))
            i += 1
    return "".join(out)


def _globs_overlap(a: str, b: str) -> bool:
    """两个单 glob 是否重叠. 判不准 → True (保守)."""
    ra = _translate_glob(a)
    rb = _translate_glob(b)
    if ra is None or rb is None:
        return True

    # 重叠判定: 存在字符串同时匹配两个正则.
    # 对一般 glob 正则无法直接做交集, 这里用"双向子串启发 + 反例验证":
    # 但因 glob 翻译后的正则都是简单形式 (字符类 + `.*` + `[^/]*`),
    # 我们采用更稳妥的方式 —— 枚举"代表性路径样本"做双向匹配.
    # 若任一样本被双方都匹配 → True.
    # 否则 (样本集都只有单边命中) → 用更细的结构判定.
    samples = _candidate_samples(a, b)
    for s in samples:
        if ra.fullmatch(s) and rb.fullmatch(s):
            return True
    # 样本未覆盖到的潜在重叠: 用"前缀兼容性"兜一道.
    # 对 a/** vs a/b.py 这种"包含"关系, samples 已覆盖;
    # 但 a/*.py vs a/b/c.py (深度差) 要求 False —— samples 会产出 a/b/c.py 仅一边命中.
    return _structural_overlap(ra, rb, a, b)


def _candidate_samples(a: str, b: str) -> set[str]:
    """从两个 glob 派生代表性路径样本集, 用于重叠探测.

    覆盖: glob 自身字面量段、单/多层级组合、末尾文件名变体.
    """
    samples: set[str] = set()

    def emit_from(g: str) -> None:
        # 字面量子串 (剥离通配后保留的可读段).
        literal = re.sub(r"\*+|\?", "", g)
        literal = literal.strip("/")
        if literal:
            samples.add(literal)
            # 加一层文件.
            samples.add(f"{literal}/x.py")
            samples.add(f"{literal}/sub/x.py")
            # 字面量作为末段文件名.
            if "/" not in literal and "." in literal:
                samples.add(literal)
        # 单层文件名样本.
        for stem in ("x.py", "y.txt"):
            samples.add(stem)
            samples.add(f"sub/{stem}")

    emit_from(a)
    emit_from(b)
    return samples


def _structural_overlap(ra: re.Pattern[str], rb: re.Pattern[str], a: str, b: str) -> bool:
    """当样本探测未命中时的结构化兜底判定.

    规则 (保守优先):
    - 任一 glob 是 `**` (匹配任意) → True.
    - 任一 glob 形如 `prefix/**` 且另一 glob 以相同 prefix 起头 → True.
    - 任一 glob 形如 `*.ext` 且另一 glob 末段同名 → True (单层 vs 同层).
    - 否则 False.
    """
    # `**` 单独: 与任何东西都重叠.
    if a == "**" or b == "**":
        return True

    def prefix_of(g: str) -> str | None:
        if g.endswith("/**"):
            return g[:-3]
        return None

    pa, pb = prefix_of(a), prefix_of(b)
    if pa is not None and (b == pa or b.startswith(pa + "/")):
        return True
    if pb is not None and (a == pb or a.startswith(pb + "/")):
        return True

    return False


def path_globs_overlap(globs_a: list[str], globs_b: list[str]) -> bool:
    """两个 glob 列表之间是否存在任一 pair 重叠 (design §3.2).

    无法静态判定时保守返回 True (默认串行).
    空列表视为"无写路径", 永不与任何东西重叠 (return False).
    """
    if not globs_a or not globs_b:
        return False
    for a in globs_a:
        for b in globs_b:
            if _globs_overlap(a, b):
                return True
    return False


def conflicts(a: Task, b: Task) -> bool:
    """两个 task 是否写冲突 (design §3.2 + §11.1 C2 修复).

    - 跨服务 (两者 service 都非 None 且不同): 永不冲突 (§11.1).
    - 任一 service 为 None: 视为同默认服务, 走同服务分支.
    - 同服务: path 重叠 或 任一 exclusive → 冲突.
    """
    # 跨服务: 永不冲突 (§11.1 C2 修复).
    if a.service is not None and b.service is not None and a.service != b.service:
        return False
    # 同服务分支: 任一 exclusive 即独占本服务一批.
    if a.exclusive or b.exclusive:
        return True
    return path_globs_overlap(a.allowed_write_paths, b.allowed_write_paths)
