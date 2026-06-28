/**
 * OpenCode adapter 端到端回归测试 (P2-B go/no-go 门禁的一部分)。
 *
 * 目的: 守住 install_oc.test.ts (workspace src 形态) 覆盖不到的 "bundle 形态" 盲区——
 * adapter-oc 的 install.ts 被 tsup 打进 packages/cli/dist/index.mjs 后:
 *   1. repoRoot() 的 import.meta.url 逐级向上行走必须仍能命中含 core/manifest.json 的仓库根;
 *   2. adapter-oc 渲染 OC agent frontmatter 依赖的 js-yaml 必须一并 bundle 进 CLI
 *      (tsup.config.ts noExternal 含 "js-yaml"), 否则 `node cli/dist/index.mjs install --host oc`
 *      会因找不到 js-yaml 在运行时崩溃。
 *
 * 本测试用【构建后的真实 node bundle】跑一次 `install --host oc`, 断言:
 *   - .opencode/agents/<4 个 subagent>.md 与 .opencode/opencode.json 落盘且非空;
 *   - 与 CC 共享的 .claude/skills/loop-engineering/SKILL.md 落盘且非空;
 *   - stdout 把这些计入 installed (+), 不计入 skipped (~)。
 *
 * 这是 "bundle 形态" 专属回归探针, 与 install_oc.test.ts 的 "src 形态" 互补。
 */
import { test, expect, beforeAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, execFileSync } from "node:child_process";

/** 4 个 subagent 文件名 (与 core/subagents/ 对齐)。 */
const AGENT_FILES = [
  "clarification-finder.md",
  "implementation-worker.md",
  "plan-agent.md",
  "red-team-reviewer.md",
] as const;

/**
 * 定位仓库根: 从测试文件位置 (tests-ts/ 直属仓库根) 向上找; 兜底用 process.cwd()。
 * 判据: 含 core/manifest.json 且含 packages/adapter-oc。
 */
function resolveRepoRoot(): string {
  const candidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    process.cwd(),
  ];
  for (const c of candidates) {
    if (
      fs.existsSync(path.join(c, "core", "manifest.json")) &&
      fs.existsSync(path.join(c, "packages", "adapter-oc"))
    ) {
      return c;
    }
  }
  throw new Error(`无法定位仓库根 (尝试: ${candidates.join(", ")})`);
}

const REPO_ROOT = resolveRepoRoot();
const CLI_BUNDLE = path.join(REPO_ROOT, "packages", "cli", "dist", "index.mjs");

beforeAll(() => {
  // 构建确保 cli/dist 是最新产物 (含 adapter-oc + js-yaml bundle)。
  execSync("npm run build", { cwd: REPO_ROOT, stdio: "pipe" });
});

test("e2e: node 跑构建后的 CLI bundle, host=oc 资产真实落盘且非空", () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-oc-e2e-"));
  try {
    // 用真实 node 跑 bundle 后的 CLI (不经 bun / 不经 workspace src import)。
    // 若 js-yaml 未 bundle, 这里会在 install 写 agent 时抛 "Cannot find module 'js-yaml'"。
    const stdout = execFileSync(
      process.execPath, // 当前 node 可执行文件
      [CLI_BUNDLE, "install", "--host", "oc", "--project-dir", projectDir],
      { cwd: REPO_ROOT, encoding: "utf-8" },
    );

    // 1. .opencode/agents/<4>.md 存在且非空
    const agentsDir = path.join(projectDir, ".opencode", "agents");
    for (const f of AGENT_FILES) {
      const p = path.join(agentsDir, f);
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.statSync(p).size).toBeGreaterThan(0);
      // frontmatter 转换确实跑了 (js-yaml 在场的正向证明)
      expect(fs.readFileSync(p, "utf-8")).toContain("mode: subagent");
    }

    // 2. .opencode/opencode.json 存在且非空, permission.skill === "allow"
    const cfgPath = path.join(projectDir, ".opencode", "opencode.json");
    expect(fs.existsSync(cfgPath)).toBe(true);
    expect(fs.statSync(cfgPath).size).toBeGreaterThan(0);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect((cfg.permission as Record<string, unknown>).skill).toBe("allow");

    // 3. 与 CC 共享的 SKILL.md 落盘且非空
    const skillPath = path.join(
      projectDir,
      ".claude",
      "skills",
      "loop-engineering",
      "SKILL.md",
    );
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(fs.statSync(skillPath).size).toBeGreaterThan(0);

    // 4. stdout: skipped 计数为 0 (空项目首装, 无冲突)
    const m = stdout.match(/install 完成: installed (\d+), skipped (\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![2])).toBe(0);

    // 5. installed 行确实包含 OC 关键资产 (正向确认走了写入分支)
    for (const f of AGENT_FILES) {
      const writeLine = new RegExp(
        `\\+ \\.opencode/agents/${f.replace(".", "\\.")}`,
      );
      expect(writeLine.test(stdout)).toBe(true);
    }
    expect(/\+ \.opencode\/opencode\.json/.test(stdout)).toBe(true);

    // 6. 兜底: stdout 不含 "OC 资产被跳过" 的行 (agents / opencode.json)
    const skipTargets = [
      ...AGENT_FILES.map((f) => `.opencode/agents/${f}`),
      ".opencode/opencode.json",
    ];
    for (const rel of skipTargets) {
      // 跳过行形如 "  ~ <rel> (跳过)"
      const skipLine = new RegExp(
        `~ ${rel.replace(/[.\\/]/g, (c) => "\\" + c)}.*\\(跳过\\)`,
      );
      expect(skipLine.test(stdout)).toBe(false);
    }
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
