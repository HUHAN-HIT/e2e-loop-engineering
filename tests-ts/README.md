# tests-ts/ — TypeScript 等价测试目录

本目录是 Python `tests/` 的 **TS 等价测试**, 规范源见
`docs/loop-engineering-cross-host-design.md` §9.4 / §13。

## 约定

- 测试框架: **bun:test** (设计 D-4 选定 Bun 作为测试/运行时)。
  每个用例 `import { test, expect } from "bun:test"`。
- 被测代码通过 workspace 导入, 例如 `import { matchPath } from "@e2e-loop/shared"`。
- 源用例来自 Python `tests/`: 把算法 SSOT 的 Python 断言逐条迁成 TS 等价断言,
  保证双宿主行为一致。

## 运行

```bash
# 本机已装 bun
bun test

# 本机未装 bun (用 npx 拉取固定版本)
npx --yes bun@1.3.14 test tests-ts/
```

bun 默认递归发现 `*.test.ts`, 无需额外配置; 如需限定可加根 `bunfig.toml`,
但通常不必。

## 文件

- `harness.test.ts` — 最小冒烟用例, 用于验证 bun + workspace 导入链路是否打通,
  长期保留。
