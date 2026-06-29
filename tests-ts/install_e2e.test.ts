/**
 * Claude Code adapter 端到端回归测试 (P1 go/no-go 门禁的一部分)。
 *
 * 目的: 守住一个 install.test.ts (workspace src 形态) 覆盖不到的真实 bug——
 * install.ts 被 tsup 打进 packages/cli/dist/index.js 后, 旧的 import.meta.url 固定
 * 向上两级定位会把 adapterRoot 误算成 packages/cli, 于是 4 个 hook .mjs 去
 * packages/cli/dist 找 (不存在) → 静默跳过 → 目标项目里压根没有 .claude/hooks/。
 *
 * 本测试用【构建后的真实 node bundle】跑一次 install, 断言 4 个 hook .mjs 确实落盘且非空,
 * 且 stdout 不再把 hooks 计入 skipped。这是"bundle 形态"专属的回归探针, 与 install.test.ts
 * 的"src 形态"互补, 共同封住"src 测试绿、bundle 形态坏"的盲区。
 */
import { test, expect, beforeAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, execFileSync } from "node:child_process";

/** 4 个 hook 的逻辑名 (与 dist/<name>.mjs 1:1)。 */
const HOOK_NAMES = [
  "probe_and_gate",
  "guard_paths",
  "post_task_collect",
  "guard_anchors",
] as const;

/**
 * 定位仓库根: 从测试文件位置 (tests-ts/ 直属仓库根) 向上找; 兜底用 process.cwd()
 * (测试运行 cwd 通常就是仓库根)。判据与 install.ts 一致: 同时含 core/manifest.json
 * 与 packages/adapter-cc。
 */
function resolveRepoRoot(): string {
  const candidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    process.cwd(),
  ];
  for (const c of candidates) {
    if (
      fs.existsSync(path.join(c, "core", "manifest.json")) &&
      fs.existsSync(path.join(c, "packages", "adapter-cc"))
    ) {
      return c;
    }
  }
  throw new Error(
    `无法定位仓库根 (尝试: ${candidates.join(", ")})`,
  );
}

const REPO_ROOT = resolveRepoRoot();
const CLI_BUNDLE = path.join(REPO_ROOT, "packages", "cli", "dist", "index.js");

beforeAll(() => {
  // 构建很快 (约几十 ms), 确保 cli/dist 与 adapter-cc/dist 都是最新产物。
  execSync("npm run build", { cwd: REPO_ROOT, stdio: "pipe" });
}, 30000);

test("e2e: node 跑构建后的 CLI bundle, 4 个 hook .mjs 真实落盘且非空", () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-cc-e2e-"));
  try {
    // 用真实 node 跑 bundle 后的 CLI (不经 bun / 不经 workspace src import)
    const stdout = execFileSync(
      process.execPath, // 当前 node 可执行文件
      [CLI_BUNDLE, "install", "--host", "cc", "--project-dir", projectDir],
      { cwd: REPO_ROOT, encoding: "utf-8" },
    );

    // 1. 4 个 hook .mjs 确实存在且非空 (核心断言: bug 修复前这里全是 missing)
    const hooksDir = path.join(
      projectDir,
      ".claude",
      "hooks",
      "loop_engineering",
    );
    for (const n of HOOK_NAMES) {
      const f = path.join(hooksDir, `${n}.mjs`);
      expect(fs.existsSync(f)).toBe(true);
      expect(fs.statSync(f).size).toBeGreaterThan(0);
    }

    // 2. stdout 不再把 hooks 计入 skipped。
    //    bug 现象是 "installed 13, skipped 4" 且 4 个 skipped 全是 hooks。
    //    修复后应 "skipped 0"。解析 installed/skipped 计数并断言 skipped 行不含 hook。
    const m = stdout.match(/install 完成: installed (\d+), skipped (\d+)/);
    expect(m).not.toBeNull();
    const skippedCount = Number(m![2]);
    expect(skippedCount).toBe(0);

    // 兜底: 即便计数解析变化, 也要确保 stdout 里没有"hook 被跳过"的行
    for (const n of HOOK_NAMES) {
      // 跳过行形如 "  ~ .claude/hooks/loop_engineering/<n>.mjs (跳过)"
      const skipLine = new RegExp(
        `~ .*${n}\\.mjs.*\\(跳过\\)`,
      );
      expect(skipLine.test(stdout)).toBe(false);
    }

    // 3. installed 行确实包含 4 个 hook (正向确认它们走了写入分支)
    for (const n of HOOK_NAMES) {
      const writeLine = new RegExp(
        `\\+ \\.claude/hooks/loop_engineering/${n}\\.mjs`,
      );
      expect(writeLine.test(stdout)).toBe(true);
    }
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
