/**
 * host=both 端到端集成测试 (P2-B go/no-go 门禁的一部分)。
 *
 * 目的: 验证 `install --host both` 一次落盘两套宿主资产, 且共享层不冲突:
 *   - CC 侧: .claude/settings.json + .claude/hooks/loop_engineering/<4>.mjs + .claude/agents/<4>.md
 *   - OC 侧: .opencode/agents/<4>.md + .opencode/opencode.json
 *   - 共享: .claude/skills/loop-engineering/SKILL.md (两宿主同一份文件, 不冲突)
 *
 * both 合并策略 (规范源: docs/loop-engineering-cross-host-design.md §7):
 *   CLI 顺序跑 CC → OC。CC 先写 .claude/skills/ 下的 SKILL/standards/README; OC 第二次跑时
 *   (force=false) 这些共享文件进 OC 段的 skipped——这是【预期】, 不算错。SKILL.md 最终存在
 *   且非空即可。本测试用构建后的真实 node bundle 跑, 同时覆盖 bundle 形态 (js-yaml 在场)。
 */
import { test, expect, beforeAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, execFileSync } from "node:child_process";

/** 4 个 hook 的逻辑名 (CC 侧 .mjs)。 */
const HOOK_NAMES = [
  "probe_and_gate",
  "guard_paths",
  "post_task_collect",
  "guard_anchors",
] as const;

/** 4 个 subagent 文件名 (CC 与 OC 两侧都有, 路径不同)。 */
const AGENT_FILES = [
  "clarification-finder.md",
  "implementation-worker.md",
  "plan-agent.md",
  "red-team-reviewer.md",
] as const;

/** 定位仓库根 (含 core/manifest.json + packages/adapter-cc + packages/adapter-oc)。 */
function resolveRepoRoot(): string {
  const candidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    process.cwd(),
  ];
  for (const c of candidates) {
    if (
      fs.existsSync(path.join(c, "core", "manifest.json")) &&
      fs.existsSync(path.join(c, "packages", "adapter-cc")) &&
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
  execSync("npm run build", { cwd: REPO_ROOT, stdio: "pipe" });
});

test("e2e: install --host both 一次装好 CC 侧 + OC 侧, 共享 SKILL 不冲突", () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-both-e2e-"));
  try {
    const stdout = execFileSync(
      process.execPath,
      [CLI_BUNDLE, "install", "--host", "both", "--project-dir", projectDir],
      { cwd: REPO_ROOT, encoding: "utf-8" },
    );

    // ---------------- CC 侧 ----------------
    const claude = path.join(projectDir, ".claude");

    // settings.json
    const settingsPath = path.join(claude, "settings.json");
    expect(fs.existsSync(settingsPath)).toBe(true);
    expect(fs.statSync(settingsPath).size).toBeGreaterThan(0);

    // 4 个 hook .mjs 落盘且非空
    for (const n of HOOK_NAMES) {
      const p = path.join(claude, "hooks", "loop_engineering", `${n}.mjs`);
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.statSync(p).size).toBeGreaterThan(0);
    }

    // CC 侧 4 个 agents/*.md (走 .claude/agents/)
    for (const f of AGENT_FILES) {
      const p = path.join(claude, "agents", f);
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.statSync(p).size).toBeGreaterThan(0);
    }

    // ---------------- OC 侧 ----------------
    const opencode = path.join(projectDir, ".opencode");

    // OC 侧 4 个 agents/*.md (走 .opencode/agents/, frontmatter 已转换)
    for (const f of AGENT_FILES) {
      const p = path.join(opencode, "agents", f);
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.statSync(p).size).toBeGreaterThan(0);
      expect(fs.readFileSync(p, "utf-8")).toContain("mode: subagent");
    }

    // OC 侧 opencode.json, permission.skill === "allow"
    const cfgPath = path.join(opencode, "opencode.json");
    expect(fs.existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect((cfg.permission as Record<string, unknown>).skill).toBe("allow");

    // ---------------- 共享层 ----------------
    // SKILL.md 两宿主共享同一份, 最终存在且非空 (不冲突)
    const skillPath = path.join(
      claude,
      "skills",
      "loop-engineering",
      "SKILL.md",
    );
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(fs.statSync(skillPath).size).toBeGreaterThan(0);

    // ---------------- stdout 分段标注 ----------------
    // both 模式输出按宿主分段, 含 [cc] 与 [oc] 前缀的 install 完成行
    expect(/\[cc\] install 完成:/.test(stdout)).toBe(true);
    expect(/\[oc\] install 完成:/.test(stdout)).toBe(true);
    // CC 段应写入 hook .mjs (正向确认 CC 资产落盘)
    expect(
      /\[cc\] \+ \.claude\/hooks\/loop_engineering\/probe_and_gate\.mjs/.test(
        stdout,
      ),
    ).toBe(true);
    // OC 段应写入 .opencode/agents (正向确认 OC 资产落盘)
    expect(/\[oc\] \+ \.opencode\/agents\/plan-agent\.md/.test(stdout)).toBe(
      true,
    );
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("e2e: install --host both, 共享 .claude/skills 由 CC 先写, OC 段标为 skipped (预期)", () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-both-share-"));
  try {
    const stdout = execFileSync(
      process.execPath,
      [CLI_BUNDLE, "install", "--host", "both", "--project-dir", projectDir],
      { cwd: REPO_ROOT, encoding: "utf-8" },
    );

    // OC 段会把共享的 SKILL.md 标为跳过 ("[oc]  ~ .claude/skills/.../SKILL.md (跳过)")。
    // 这是 both 合并策略的预期行为: CC 先写共享层, OC 第二次跑 force=false 即跳过。
    const ocSkipSkill =
      /\[oc\] ~ \.claude\/skills\/loop-engineering\/SKILL\.md \(跳过\)/.test(
        stdout,
      );
    expect(ocSkipSkill).toBe(true);

    // 但 OC 私有资产 (agents / opencode.json) 仍由 OC 写入, 不应被跳过
    expect(
      /\[oc\] ~ \.opencode\/agents\/plan-agent\.md \(跳过\)/.test(stdout),
    ).toBe(false);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
