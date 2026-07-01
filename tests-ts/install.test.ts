/**
 * Claude Code adapter install / dryRun / uninstall 集成测试 (P1 go/no-go 门禁的一部分)。
 *
 * 目的: 验证 adapter-cc 的落盘布局、settings 合并、幂等语义、--force 覆盖、uninstall
 * 清痕迹, 与 Python 行为权威 `loop_engineering/claude_assets.py:install_claude_assets`
 * + `tests/test_claude_assets.py` 完全对齐 (跨宿主兼容性硬要求)。
 *
 * 关键差异说明 (TS 端独有, 不算偏离权威):
 * - hooks 落盘为 .mjs (Node 运行时), Python 端为 .py; 这是 D-4 宿主选型决定的形态差异。
 * - settings.json 默认命令为 CLI 形式 `e2e-loop hook <dash-name>` (默认 CLI 注册模式;
 *   修复 .mjs 在新 worktree 缺失导致 MODULE_NOT_FOUND 的隐患)。.mjs 文件仍照常落盘,
 *   仅 `hookMode:"local"` 逃生舱才在 settings 里用本地 `node ... .mjs` 命令。
 *
 * 每个用例使用独立临时 projectDir (os.tmpdir() 下), 结束清理。
 */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claudeCodeAdapter } from "@e2e-loop/adapter-claude-code";

/** 4 个 hook 的逻辑名 (与 dist/<name>.mjs 1:1)。 */
const HOOK_NAMES = [
  "probe_and_gate",
  "guard_paths",
  "post_task_collect",
  "guard_anchors",
] as const;

/** craft 标准层文件名 (与 core/standards/ + Python CRAFT_STANDARDS 对齐)。 */
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "loop-cc-install-"));
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

/** 读取并 JSON.parse settings.json。 */
function readSettings(projectDir: string): Record<string, unknown> {
  const p = path.join(projectDir, ".claude", "settings.json");
  return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
}

/** 从 settings.hooks 收集所有 hook command 字符串 (对齐 Python _all_hook_commands)。 */
function allHookCommands(settings: Record<string, unknown>): string[] {
  const cmds: string[] = [];
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  for (const groups of Object.values(hooks)) {
    for (const g of (groups as Array<Record<string, unknown>>) ?? []) {
      const hs = (g?.hooks ?? []) as Array<Record<string, unknown>>;
      for (const h of hs) {
        const c = h?.command;
        if (typeof c === "string") cmds.push(c);
      }
    }
  }
  return cmds;
}

// ---------------------------------------------------------------------------
// 用例 1: install 落盘布局完整 (对齐 Python test_install_..._copies_skill_agents_hooks_and_settings
//          + test_install_claude_assets_includes_craft_standards)
// ---------------------------------------------------------------------------
test("install: 落盘布局完整 (settings/hooks×4/SKILL/standards/agents×4)", async () => {
  const projectDir = makeTmpProject();
  try {
    const result = await claudeCodeAdapter.install({ projectDir, force: false });
    const claude = path.join(projectDir, ".claude");

    // settings.json
    expect(fs.existsSync(path.join(claude, "settings.json"))).toBe(true);

    // 4 个 hook .mjs (TS 端形态: .mjs, 非 Python .py)
    for (const n of HOOK_NAMES) {
      const p = path.join(claude, "hooks", "loop_engineering", `${n}.mjs`);
      expect(fs.existsSync(p)).toBe(true);
    }

    // SKILL.md (来自 core/coordinator.md)
    expect(
      fs.existsSync(path.join(claude, "skills", "loop-engineering", "SKILL.md")),
    ).toBe(true);

    // standards/*.md
    const standardsDir = path.join(
      claude,
      "skills",
      "loop-engineering",
      "standards",
    );
    for (const name of CRAFT_STANDARDS) {
      expect(fs.existsSync(path.join(standardsDir, `${name}.md`))).toBe(true);
    }

    // agents/*.md ×4 (来自 core/subagents/)
    for (const f of AGENT_FILES) {
      expect(fs.existsSync(path.join(claude, "agents", f))).toBe(true);
    }

    // install 确实写入了文件, 无意外跳过 (空项目首装)
    expect(result.writtenFiles.length).toBeGreaterThan(0);
    expect(result.skippedFiles).toEqual([]);
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 2: settings.json 内容含 4 个 hook 注册, 默认命令为 CLI 形式 e2e-loop hook <dash>
// ---------------------------------------------------------------------------
test("install: settings.json 含 4 个 hook 注册 (默认 CLI 命令 e2e-loop hook ...)", async () => {
  const projectDir = makeTmpProject();
  try {
    await claudeCodeAdapter.install({ projectDir, force: false });
    const settings = readSettings(projectDir);
    const cmds = allHookCommands(settings);

    for (const n of HOOK_NAMES) {
      const expected = `e2e-loop hook ${n.replaceAll("_", "-")}`;
      expect(cmds).toContain(expected);
    }
    // 恰好 4 条本工具 hook (无多余/无重复)
    const ours = cmds.filter((c) => c.startsWith("e2e-loop hook "));
    expect(ours.length).toBe(4);
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 3: 幂等 — 第二次 install(force:false) writtenFiles 为空, 全部 skipped
//          (对齐 Python test_install_settings_merge_is_idempotent 的语义)
// ---------------------------------------------------------------------------
test("install: 幂等 — 第二次 force:false 全部 skipped (含 settings.json)", async () => {
  const projectDir = makeTmpProject();
  try {
    const first = await claudeCodeAdapter.install({ projectDir, force: false });
    expect(first.writtenFiles.length).toBeGreaterThan(0);

    const second = await claudeCodeAdapter.install({ projectDir, force: false });

    // 第二次不应再写任何文件
    expect(second.writtenFiles).toEqual([]);
    // 全部条目都进 skipped (含 settings.json — mergeHooks 幂等, merged===existing → skipped)
    expect(second.skippedFiles).toContain(".claude/settings.json");
    expect(second.skippedFiles.length).toBe(first.writtenFiles.length);

    // settings.json 仍只有 4 条本工具 hook (未被重复注入)
    const cmds = allHookCommands(readSettings(projectDir));
    for (const n of HOOK_NAMES) {
      const expected = `e2e-loop hook ${n.replaceAll("_", "-")}`;
      expect(cmds.filter((c) => c === expected).length).toBe(1);
    }
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 4: --force 覆盖 — force:true 改写已存在文件
//          (对齐 Python force=True 语义)
// ---------------------------------------------------------------------------
test("install: --force 覆盖已存在文件", async () => {
  const projectDir = makeTmpProject();
  try {
    await claudeCodeAdapter.install({ projectDir, force: false });

    // 篡改一个已落盘文件 (SKILL.md), 模拟旧版本
    const skill = path.join(
      projectDir,
      ".claude",
      "skills",
      "loop-engineering",
      "SKILL.md",
    );
    fs.writeFileSync(skill, "STALE-CONTENT", "utf-8");
    expect(fs.readFileSync(skill, "utf-8")).toBe("STALE-CONTENT");

    // force:true 应改写回 canonical 内容
    const result = await claudeCodeAdapter.install({ projectDir, force: true });
    expect(result.writtenFiles).toContain(
      ".claude/skills/loop-engineering/SKILL.md",
    );
    const after = fs.readFileSync(skill, "utf-8");
    expect(after).not.toBe("STALE-CONTENT");
    expect(after.length).toBeGreaterThan(0);
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 5: settings.json 合并 — 保留用户配置 + 并入本工具 4 个 hook (不重复/不丢)
//          (对齐 Python test_install_merges_into_existing_settings)
// ---------------------------------------------------------------------------
test("install: settings.json 深合并 — 保留用户配置且并入 4 个 hook", async () => {
  const projectDir = makeTmpProject();
  try {
    // 预先写一个含用户自定义 hook + 其它配置的 settings.json
    const claude = path.join(projectDir, ".claude");
    fs.mkdirSync(claude, { recursive: true });
    const userSettings = {
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: {
        PreToolUse: [
          {
            matcher: "Read",
            hooks: [{ type: "command", command: "echo user-hook" }],
          },
        ],
      },
    };
    fs.writeFileSync(
      path.join(claude, "settings.json"),
      JSON.stringify(userSettings),
      "utf-8",
    );

    await claudeCodeAdapter.install({ projectDir, force: false });

    const merged = readSettings(projectDir);
    // 用户其它配置必须保留
    expect((merged.permissions as Record<string, unknown>).allow).toEqual([
      "Bash(ls:*)",
    ]);
    const cmds = allHookCommands(merged);
    // 用户原有 hook 必须保留
    expect(cmds).toContain("echo user-hook");
    // 本工具 4 个 hook 被并入 (默认 CLI 命令)
    for (const n of HOOK_NAMES) {
      expect(cmds).toContain(`e2e-loop hook ${n.replaceAll("_", "-")}`);
    }
    // 不重复: 每个本工具 hook 恰好 1 条
    for (const n of HOOK_NAMES) {
      const expected = `e2e-loop hook ${n.replaceAll("_", "-")}`;
      expect(cmds.filter((c) => c === expected).length).toBe(1);
    }
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 6: uninstall — 清掉本工具痕迹, removedFiles 合理
// ---------------------------------------------------------------------------
test("uninstall: 清掉 skills/agents×4/hooks + settings 内本工具 hooks 条目", async () => {
  const projectDir = makeTmpProject();
  try {
    await claudeCodeAdapter.install({ projectDir, force: false });
    expect(claudeCodeAdapter.uninstall).toBeDefined();

    const result = await claudeCodeAdapter.uninstall!(projectDir);
    const claude = path.join(projectDir, ".claude");

    // skills/loop-engineering/ 整目录被删
    expect(
      fs.existsSync(path.join(claude, "skills", "loop-engineering")),
    ).toBe(false);
    // hooks/loop_engineering/ 整目录被删
    expect(
      fs.existsSync(path.join(claude, "hooks", "loop_engineering")),
    ).toBe(false);
    // 4 个 agents/*.md 被删
    for (const f of AGENT_FILES) {
      expect(fs.existsSync(path.join(claude, "agents", f))).toBe(false);
    }
    // settings.json 文件仍存在 (H1 修复: 不再整文件删, 改为只 strip 本工具注入的 hooks)
    expect(fs.existsSync(path.join(claude, "settings.json"))).toBe(true);
    // settings.json 内本工具注入的 hooks 已被清掉 (空了)
    const after = readSettings(projectDir);
    const cmds = allHookCommands(after);
    for (const n of HOOK_NAMES) {
      expect(cmds).not.toContain(`e2e-loop hook ${n.replaceAll("_", "-")}`);
    }

    // removedFiles 合理: 含本工具关键痕迹
    expect(result.removedFiles).toContain(".claude/skills/loop-engineering/");
    expect(result.removedFiles).toContain(".claude/hooks/loop_engineering/");
    expect(result.removedFiles).toContain(".claude/settings.json");
    for (const f of AGENT_FILES) {
      expect(result.removedFiles).toContain(`.claude/agents/${f}`);
    }
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 6b: uninstall settings.json — 保留用户自定义 hook 配置 (H1 对称性)
//          (install 用 mergeHooks 保留用户配置; uninstall 用 stripLoopEngineeringHooks
//           只删本工具注入的条目, 与 install 对称)
// ---------------------------------------------------------------------------
test("uninstall: settings.json 保留用户自定义 hook 配置 (与 install mergeHooks 对称)", async () => {
  const projectDir = makeTmpProject();
  try {
    const claude = path.join(projectDir, ".claude");
    fs.mkdirSync(claude, { recursive: true });
    // 预置用户自己的 settings.json (有用户自定义 hook + permissions)
    const userSettings = {
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: {
        PreToolUse: [
          {
            matcher: "Read",
            hooks: [{ type: "command", command: "echo user-hook" }],
          },
        ],
      },
    };
    fs.writeFileSync(
      path.join(claude, "settings.json"),
      JSON.stringify(userSettings),
      "utf-8",
    );

    await claudeCodeAdapter.install({ projectDir, force: false });
    // install 后: 用户 hook + 本工具 4 hook 共存
    const before = readSettings(projectDir);
    const cmdsBefore = allHookCommands(before);
    expect(cmdsBefore).toContain("echo user-hook");
    for (const n of HOOK_NAMES) {
      expect(cmdsBefore).toContain(`e2e-loop hook ${n.replaceAll("_", "-")}`);
    }

    await claudeCodeAdapter.uninstall!(projectDir);

    // uninstall 后: 本工具 hooks 全部清除, 用户 hook 与 permissions 必须保留
    const after = readSettings(projectDir);
    expect((after.permissions as Record<string, unknown>).allow).toEqual([
      "Bash(ls:*)",
    ]);
    const cmdsAfter = allHookCommands(after);
    expect(cmdsAfter).toContain("echo user-hook");
    for (const n of HOOK_NAMES) {
      expect(cmdsAfter).not.toContain(`e2e-loop hook ${n.replaceAll("_", "-")}`);
    }
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 6c: uninstall settings.json — 用户文件不可解析时不动 (尊重用户文件)
// ---------------------------------------------------------------------------
test("uninstall: settings.json 不可解析时保留原文件 (不抹除用户配置)", async () => {
  const projectDir = makeTmpProject();
  try {
    await claudeCodeAdapter.install({ projectDir, force: false });
    const claude = path.join(projectDir, ".claude");

    // 故意把 settings.json 改成含 JSON5 注释的不可解析内容
    const broken = "{\n  // JSON5 注释, 标准 JSON.parse 会失败\n  hooks: {}\n}";
    fs.writeFileSync(path.join(claude, "settings.json"), broken, "utf-8");

    const result = await claudeCodeAdapter.uninstall!(projectDir);

    // 文件原样保留 (uninstall 不动不可解析的用户文件)
    expect(fs.readFileSync(path.join(claude, "settings.json"), "utf-8")).toBe(
      broken,
    );
    // 标 notFound 表示"未处理" (避免假装成功)
    expect(result.notFoundFiles).toContain(".claude/settings.json");
    expect(result.removedFiles).not.toContain(".claude/settings.json");
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 7: uninstall 只删本工具痕迹, 不动用户其它 .claude 文件
// ---------------------------------------------------------------------------
test("uninstall: 保留用户在 .claude/agents 下的其它文件", async () => {
  const projectDir = makeTmpProject();
  try {
    await claudeCodeAdapter.install({ projectDir, force: false });
    // 用户在 agents/ 下放一个自己的 agent
    const userAgent = path.join(
      projectDir,
      ".claude",
      "agents",
      "my-custom-agent.md",
    );
    fs.writeFileSync(userAgent, "USER AGENT", "utf-8");

    await claudeCodeAdapter.uninstall!(projectDir);

    // 用户自己的 agent 必须保留
    expect(fs.existsSync(userAgent)).toBe(true);
    expect(fs.readFileSync(userAgent, "utf-8")).toBe("USER AGENT");
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 8: dryRun 不写盘, manifest.files / conflictFiles 合理
// ---------------------------------------------------------------------------
test("dryRun: 不写盘且 manifest 合理 (空项目无冲突)", async () => {
  const projectDir = makeTmpProject();
  try {
    const before = countFiles(projectDir);
    const manifest = await claudeCodeAdapter.dryRun({ projectDir, force: false });
    const after = countFiles(projectDir);

    // 关键: dryRun 不得写盘
    expect(after).toBe(before);

    // manifest.files 含全部预期落盘条目
    const paths = manifest.files.map((f) => f.path);
    expect(paths).toContain(".claude/settings.json");
    for (const n of HOOK_NAMES) {
      expect(paths).toContain(`.claude/hooks/loop_engineering/${n}.mjs`);
    }
    expect(paths).toContain(".claude/skills/loop-engineering/SKILL.md");
    for (const name of CRAFT_STANDARDS) {
      expect(paths).toContain(
        `.claude/skills/loop-engineering/standards/${name}.md`,
      );
    }
    for (const f of AGENT_FILES) {
      expect(paths).toContain(`.claude/agents/${f}`);
    }

    // source 标记合理: settings/hooks 为 adapter, skill/standards/agents 为 core
    const settingsEntry = manifest.files.find(
      (f) => f.path === ".claude/settings.json",
    );
    expect(settingsEntry?.source).toBe("adapter");
    const skillEntry = manifest.files.find(
      (f) => f.path === ".claude/skills/loop-engineering/SKILL.md",
    );
    expect(skillEntry?.source).toBe("core");

    // 空项目 → 无冲突
    expect(manifest.conflictFiles).toEqual([]);
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 9: dryRun 在已装项目上报告 conflictFiles (force:false; settings.json 走合并不算冲突)
// ---------------------------------------------------------------------------
test("dryRun: 已装项目上报告 conflictFiles (settings.json 例外)", async () => {
  const projectDir = makeTmpProject();
  try {
    await claudeCodeAdapter.install({ projectDir, force: false });

    const manifest = await claudeCodeAdapter.dryRun({ projectDir, force: false });

    // 已落盘的 hook/skill/agent 应进 conflictFiles
    expect(manifest.conflictFiles).toContain(
      ".claude/skills/loop-engineering/SKILL.md",
    );
    for (const n of HOOK_NAMES) {
      expect(manifest.conflictFiles).toContain(
        `.claude/hooks/loop_engineering/${n}.mjs`,
      );
    }
    // settings.json 走合并策略, 永不算冲突
    expect(manifest.conflictFiles).not.toContain(".claude/settings.json");

    // force:true 时无冲突 (一律覆盖)
    const forced = await claudeCodeAdapter.dryRun({ projectDir, force: true });
    expect(forced.conflictFiles).toEqual([]);
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 10: install 落 .gitignore 托管块且幂等
//          (根治 actual_writes 误判越界的下游诱因: 让目标仓库 git status 干净)
// ---------------------------------------------------------------------------
test("install: 写 .gitignore 托管块且幂等", async () => {
  const projectDir = makeTmpProject();
  try {
    const first = await claudeCodeAdapter.install({ projectDir, force: false });
    // 首装: .gitignore 进 writtenFiles
    expect(first.writtenFiles).toContain(".gitignore");

    // 文件含 harness ignore entries
    const gi = fs.readFileSync(path.join(projectDir, ".gitignore"), "utf-8");
    expect(gi).toContain("runs/");
    expect(gi).toContain(".claude/");
    expect(gi).toContain("# >>> loop-engineering managed >>>");

    // 二装幂等: writtenFiles 为空, skippedFiles 含 .gitignore
    const second = await claudeCodeAdapter.install({ projectDir, force: false });
    expect(second.writtenFiles).toEqual([]);
    expect(second.skippedFiles).toContain(".gitignore");
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 11: uninstall 清掉 .gitignore 托管块 (与 install 对称)
// ---------------------------------------------------------------------------
test("uninstall: 清掉 .gitignore 托管块", async () => {
  const projectDir = makeTmpProject();
  try {
    await claudeCodeAdapter.install({ projectDir, force: false });
    await claudeCodeAdapter.uninstall!(projectDir);

    // 托管块被移除: 文件不存在或不含托管块起始标记
    const target = path.join(projectDir, ".gitignore");
    if (fs.existsSync(target)) {
      const gi = fs.readFileSync(target, "utf-8");
      expect(gi).not.toContain("# >>> loop-engineering managed");
    }
    // 否则文件已被整个删除 (只含托管块时的行为), 亦满足"块被移除"
  } finally {
    cleanup(projectDir);
  }
});
