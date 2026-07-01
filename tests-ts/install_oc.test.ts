/**
 * OpenCode adapter install / dryRun / uninstall 集成测试 (P2 go/no-go 门禁的一部分)。
 *
 * 目的: 验证 adapter-opencode 的落盘布局、frontmatter 转换 (CC tools → OC permission)、
 * opencode.json 合并、幂等语义、--force 覆盖、uninstall 清痕迹且不误删用户自建 agent。
 *
 * OpenCode 官方约定 (opencode.ai/docs):
 * - SKILL 走 Claude 兼容路径 .claude/skills/<name>/SKILL.md (与 CC 共享同一文件)。
 * - Agent 走 .opencode/agents/<name>.md (复数; OC 不读 .claude/agents/), frontmatter 用
 *   description/mode/permission, 不用已废弃的 tools。
 * - opencode.json 的 permission.skill 门控 skill 工具。
 *
 * 每个用例使用独立临时 projectDir (os.tmpdir() 下), 结束清理。
 */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { opencodeAdapter } from "@e2e-loop/adapter-opencode";

/** craft 标准层文件名 (与 core/standards/ 对齐)。 */
const CRAFT_STANDARDS = [
  "glossary",
  "clarification-standard",
  "plan-standard",
  "test-design-standard",
  "implementation-standard",
  "review-standard",
] as const;

/** 4 个 subagent 文件名 (与 core/subagents/ 对齐)。 */
const AGENT_FILES = [
  "clarification-finder.md",
  "implementation-worker.md",
  "plan-agent.md",
  "red-team-reviewer.md",
] as const;

/** 在 os.tmpdir() 下建一个独立空 projectDir。 */
function makeTmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loop-oc-install-"));
}

/** 递归删除临时 projectDir (清理)。 */
function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 递归统计目录下所有文件数 (用于 dryRun 前后比对)。 */
function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) n += countFiles(p);
    else n += 1;
  }
  return n;
}

/** 读取 OpenCode agent 文件并解析出 frontmatter 文本 (--- 之间)。 */
function readAgentFrontmatter(projectDir: string, file: string): string {
  const p = path.join(projectDir, ".opencode", "agents", file);
  const text = fs.readFileSync(p, "utf-8").replace(/\r\n/g, "\n");
  expect(text.startsWith("---\n")).toBe(true);
  const end = text.indexOf("\n---\n", 4);
  expect(end).toBeGreaterThan(0);
  return text.slice(4, end);
}

/** 读取 opencode.json。 */
function readOpencodeJson(projectDir: string): Record<string, unknown> {
  const p = path.join(projectDir, ".opencode", "opencode.json");
  return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 用例 1: install 落盘布局完整 (SKILL / standards / agents×4 / opencode.json)
// ---------------------------------------------------------------------------
test("install: 落盘布局完整 (SKILL/standards/agents×4/opencode.json)", async () => {
  const projectDir = makeTmpProject();
  try {
    const result = await opencodeAdapter.install({ projectDir, force: false });

    // SKILL.md 走 Claude 兼容路径, 且 frontmatter 含 compatibility: claude-code,opencode
    const skillPath = path.join(
      projectDir,
      ".claude",
      "skills",
      "loop-engineering",
      "SKILL.md",
    );
    expect(fs.existsSync(skillPath)).toBe(true);
    const skillText = fs.readFileSync(skillPath, "utf-8");
    expect(skillText).toContain("compatibility: claude-code,opencode");

    // standards/*.md
    const standardsDir = path.join(
      projectDir,
      ".claude",
      "skills",
      "loop-engineering",
      "standards",
    );
    for (const name of CRAFT_STANDARDS) {
      expect(fs.existsSync(path.join(standardsDir, `${name}.md`))).toBe(true);
    }

    // .opencode/agents/*.md ×4
    for (const f of AGENT_FILES) {
      expect(
        fs.existsSync(path.join(projectDir, ".opencode", "agents", f)),
      ).toBe(true);
    }

    // opencode.json 存在且 permission.skill === "allow"
    const cfg = readOpencodeJson(projectDir);
    expect((cfg.permission as Record<string, unknown>).skill).toBe("allow");

    // install 确实写入了文件, 无意外跳过 (空项目首装)
    expect(result.writtenFiles.length).toBeGreaterThan(0);
    expect(result.skippedFiles).toEqual([]);
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 2: agent frontmatter 转换 — mode: subagent + permission 块, edit 权限按 tools 派生
// ---------------------------------------------------------------------------
test("install: agent frontmatter 含 mode:subagent 与 permission (edit 权限按 tools 派生)", async () => {
  const projectDir = makeTmpProject();
  try {
    await opencodeAdapter.install({ projectDir, force: false });

    // 每个 agent 都应有 mode: subagent 与 permission 块
    for (const f of AGENT_FILES) {
      const fm = readAgentFrontmatter(projectDir, f);
      expect(fm).toContain("mode: subagent");
      expect(fm).toContain("permission:");
      expect(fm).toContain("description:");
      // 不应保留 CC 的 name / tools 字段 (OC 文件名即 agent 名, tools 已废弃)
      expect(fm).not.toContain("\nname:");
      expect(fm).not.toContain("tools:");
    }

    // red-team-reviewer: tools = Read, Glob, Grep (无 Write/Edit) → edit: deny
    const reviewerFm = readAgentFrontmatter(projectDir, "red-team-reviewer.md");
    expect(reviewerFm).toContain("edit: deny");
    expect(reviewerFm).toContain("read: allow");
    expect(reviewerFm).toContain("glob: allow");
    expect(reviewerFm).toContain("grep: allow");
    expect(reviewerFm).toContain("bash: deny");

    // implementation-worker: tools 含 Write/Edit/Bash → edit: allow, bash: allow
    const workerFm = readAgentFrontmatter(
      projectDir,
      "implementation-worker.md",
    );
    expect(workerFm).toContain("edit: allow");
    expect(workerFm).toContain("read: allow");
    expect(workerFm).toContain("bash: allow");
    expect(workerFm).toContain("glob: allow");
    expect(workerFm).toContain("grep: allow");

    // clarification-finder: tools = Read, Write → edit: allow, bash: deny, glob: deny
    const clarFm = readAgentFrontmatter(projectDir, "clarification-finder.md");
    expect(clarFm).toContain("edit: allow");
    expect(clarFm).toContain("bash: deny");
    expect(clarFm).toContain("glob: deny");
    expect(clarFm).toContain("grep: deny");
    expect(clarFm).toContain("task: deny");
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 3: agent 正文原样保留 (frontmatter 之后内容不丢)
// ---------------------------------------------------------------------------
test("install: agent 正文原样保留", async () => {
  const projectDir = makeTmpProject();
  try {
    await opencodeAdapter.install({ projectDir, force: false });
    for (const f of AGENT_FILES) {
      const text = fs
        .readFileSync(
          path.join(projectDir, ".opencode", "agents", f),
          "utf-8",
        )
        .replace(/\r\n/g, "\n");
      // 第二个 --- 之后应有非空正文
      const end = text.indexOf("\n---\n", 4);
      const body = text.slice(end + "\n---\n".length);
      expect(body.trim().length).toBeGreaterThan(0);
    }
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 4: 幂等 — 第二次 install(force:false) writtenFiles 为空, 全部 skipped
// ---------------------------------------------------------------------------
test("install: 幂等 — 第二次 force:false 全部 skipped (含 opencode.json)", async () => {
  const projectDir = makeTmpProject();
  try {
    const first = await opencodeAdapter.install({ projectDir, force: false });
    expect(first.writtenFiles.length).toBeGreaterThan(0);

    const second = await opencodeAdapter.install({ projectDir, force: false });

    // 第二次不应再写任何文件
    expect(second.writtenFiles).toEqual([]);
    // opencode.json 走合并, 第二次 merged===existing → skipped
    expect(second.skippedFiles).toContain(".opencode/opencode.json");
    expect(second.skippedFiles.length).toBe(first.writtenFiles.length);
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 5: --force 覆盖已存在文件
// ---------------------------------------------------------------------------
test("install: --force 覆盖已存在文件", async () => {
  const projectDir = makeTmpProject();
  try {
    await opencodeAdapter.install({ projectDir, force: false });

    // 篡改一个已落盘 agent, 模拟旧版本
    const agent = path.join(
      projectDir,
      ".opencode",
      "agents",
      "plan-agent.md",
    );
    fs.writeFileSync(agent, "STALE-CONTENT", "utf-8");
    expect(fs.readFileSync(agent, "utf-8")).toBe("STALE-CONTENT");

    const result = await opencodeAdapter.install({ projectDir, force: true });
    expect(result.writtenFiles).toContain(".opencode/agents/plan-agent.md");
    const after = fs.readFileSync(agent, "utf-8");
    expect(after).not.toBe("STALE-CONTENT");
    expect(after).toContain("mode: subagent");
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 6: opencode.json 合并 — 保留预置用户字段, 仅确保 permission.skill 存在
// ---------------------------------------------------------------------------
test("install: opencode.json 合并保留用户字段且确保 permission.skill", async () => {
  const projectDir = makeTmpProject();
  try {
    // 预置一个含用户自定义字段的 opencode.json (permission 已有但无 skill)
    const ocDir = path.join(projectDir, ".opencode");
    fs.mkdirSync(ocDir, { recursive: true });
    const userCfg = {
      $schema: "https://opencode.ai/config.json",
      theme: "tokyonight",
      model: "anthropic/claude-3-5-sonnet",
      permission: { bash: "ask" },
    };
    fs.writeFileSync(
      path.join(ocDir, "opencode.json"),
      JSON.stringify(userCfg),
      "utf-8",
    );

    await opencodeAdapter.install({ projectDir, force: false });

    const merged = readOpencodeJson(projectDir);
    // 用户字段全部保留
    expect(merged.theme).toBe("tokyonight");
    expect(merged.model).toBe("anthropic/claude-3-5-sonnet");
    const perm = merged.permission as Record<string, unknown>;
    expect(perm.bash).toBe("ask"); // 用户原有 permission 字段保留
    // 本工具确保 permission.skill 存在
    expect(perm.skill).toBe("allow");
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 7: opencode.json 合并 — 用户已设 skill 值不被覆盖
// ---------------------------------------------------------------------------
test("install: opencode.json 已有 permission.skill 时不覆盖用户值", async () => {
  const projectDir = makeTmpProject();
  try {
    const ocDir = path.join(projectDir, ".opencode");
    fs.mkdirSync(ocDir, { recursive: true });
    const userCfg = { permission: { skill: "ask" } };
    fs.writeFileSync(
      path.join(ocDir, "opencode.json"),
      JSON.stringify(userCfg),
      "utf-8",
    );

    await opencodeAdapter.install({ projectDir, force: false });

    const merged = readOpencodeJson(projectDir);
    // 用户的 skill: ask 必须保留 (不被改成 allow)
    expect((merged.permission as Record<string, unknown>).skill).toBe("ask");
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 8: uninstall — 清掉本工具痕迹 (skills/agents×4/opencode.json)
// ---------------------------------------------------------------------------
test("uninstall: 清掉 skills/agents×4/opencode.json 痕迹", async () => {
  const projectDir = makeTmpProject();
  try {
    await opencodeAdapter.install({ projectDir, force: false });
    expect(opencodeAdapter.uninstall).toBeDefined();

    const result = await opencodeAdapter.uninstall!(projectDir);

    // skills/loop-engineering/ 整目录被删
    expect(
      fs.existsSync(
        path.join(projectDir, ".claude", "skills", "loop-engineering"),
      ),
    ).toBe(false);
    // 4 个 agents/*.md 被删
    for (const f of AGENT_FILES) {
      expect(
        fs.existsSync(path.join(projectDir, ".opencode", "agents", f)),
      ).toBe(false);
    }
    // opencode.json 被删
    expect(
      fs.existsSync(path.join(projectDir, ".opencode", "opencode.json")),
    ).toBe(false);

    // removedFiles 合理
    expect(result.removedFiles).toContain(".claude/skills/loop-engineering/");
    expect(result.removedFiles).toContain(".opencode/opencode.json");
    for (const f of AGENT_FILES) {
      expect(result.removedFiles).toContain(`.opencode/agents/${f}`);
    }
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 9: uninstall 不误删用户在 .opencode/agents/ 的自建 agent
// ---------------------------------------------------------------------------
test("uninstall: 保留用户在 .opencode/agents 下的自建 agent", async () => {
  const projectDir = makeTmpProject();
  try {
    await opencodeAdapter.install({ projectDir, force: false });
    // 用户在 .opencode/agents/ 下放一个自己的 agent
    const userAgent = path.join(
      projectDir,
      ".opencode",
      "agents",
      "my-custom-agent.md",
    );
    fs.writeFileSync(userAgent, "USER AGENT", "utf-8");

    await opencodeAdapter.uninstall!(projectDir);

    // 用户自己的 agent 必须保留
    expect(fs.existsSync(userAgent)).toBe(true);
    expect(fs.readFileSync(userAgent, "utf-8")).toBe("USER AGENT");
    // agents 目录本身不被删 (因还有用户文件)
    expect(
      fs.existsSync(path.join(projectDir, ".opencode", "agents")),
    ).toBe(true);
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 10: dryRun 不写盘, manifest 合理
// ---------------------------------------------------------------------------
test("dryRun: 不写盘且 manifest 合理 (空项目无冲突)", async () => {
  const projectDir = makeTmpProject();
  try {
    const before = countFiles(projectDir);
    const manifest = await opencodeAdapter.dryRun({ projectDir, force: false });
    const after = countFiles(projectDir);

    // 关键: dryRun 不得写盘
    expect(after).toBe(before);

    // manifest.files 含全部预期落盘条目
    const paths = manifest.files.map((f) => f.path);
    expect(paths).toContain(".claude/skills/loop-engineering/SKILL.md");
    for (const name of CRAFT_STANDARDS) {
      expect(paths).toContain(
        `.claude/skills/loop-engineering/standards/${name}.md`,
      );
    }
    for (const f of AGENT_FILES) {
      expect(paths).toContain(`.opencode/agents/${f}`);
    }
    expect(paths).toContain(".opencode/opencode.json");

    // source 标记合理: skill/standards/agents 为 core, opencode.json 为 adapter
    const skillEntry = manifest.files.find(
      (f) => f.path === ".claude/skills/loop-engineering/SKILL.md",
    );
    expect(skillEntry?.source).toBe("core");
    const cfgEntry = manifest.files.find(
      (f) => f.path === ".opencode/opencode.json",
    );
    expect(cfgEntry?.source).toBe("adapter");

    // 空项目 → 无冲突
    expect(manifest.conflictFiles).toEqual([]);
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 11: dryRun 在已装项目上报告 conflictFiles (opencode.json 走合并不算冲突)
// ---------------------------------------------------------------------------
test("dryRun: 已装项目上报告 conflictFiles (opencode.json 例外)", async () => {
  const projectDir = makeTmpProject();
  try {
    await opencodeAdapter.install({ projectDir, force: false });

    const manifest = await opencodeAdapter.dryRun({ projectDir, force: false });

    // 已落盘的 skill/agent 应进 conflictFiles
    expect(manifest.conflictFiles).toContain(
      ".claude/skills/loop-engineering/SKILL.md",
    );
    for (const f of AGENT_FILES) {
      expect(manifest.conflictFiles).toContain(`.opencode/agents/${f}`);
    }
    // opencode.json 走合并策略, 永不算冲突
    expect(manifest.conflictFiles).not.toContain(".opencode/opencode.json");

    // force:true 时无冲突
    const forced = await opencodeAdapter.dryRun({ projectDir, force: true });
    expect(forced.conflictFiles).toEqual([]);
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 12: install 写 .gitignore 托管块且幂等 (与 adapter-cc 对称)
// ---------------------------------------------------------------------------
test("install: 写 .gitignore 托管块且幂等", async () => {
  const projectDir = makeTmpProject();
  try {
    const first = await opencodeAdapter.install({ projectDir, force: false });
    // 首装: .gitignore 不存在 → ensure 返回 "written" → 进 writtenFiles
    expect(first.writtenFiles).toContain(".gitignore");

    // .gitignore 内容含托管块锚点与产物条目
    const giText = fs.readFileSync(
      path.join(projectDir, ".gitignore"),
      "utf-8",
    );
    expect(giText).toContain("# >>> loop-engineering managed >>>");
    expect(giText).toContain("runs/");

    // 二装幂等: .gitignore 块已存在且等价 → "unchanged" → 进 skippedFiles
    const second = await opencodeAdapter.install({ projectDir, force: false });
    expect(second.writtenFiles).toEqual([]);
    expect(second.skippedFiles).toContain(".gitignore");
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 13: uninstall 清掉 .gitignore 托管块 (与 install 对称)
// ---------------------------------------------------------------------------
test("uninstall: 清掉 .gitignore 托管块", async () => {
  const projectDir = makeTmpProject();
  try {
    await opencodeAdapter.install({ projectDir, force: false });
    await opencodeAdapter.uninstall!(projectDir);

    // 卸载后: 若 .gitignore 仍存在 (用户另有条目), 其内容不得再含托管块锚点;
    // 若剩余为空则整文件已删, 同样满足 (无残留托管块)。
    const giPath = path.join(projectDir, ".gitignore");
    if (fs.existsSync(giPath)) {
      const giText = fs.readFileSync(giPath, "utf-8");
      expect(giText).not.toContain("# >>> loop-engineering managed");
    }
  } finally {
    cleanup(projectDir);
  }
});
