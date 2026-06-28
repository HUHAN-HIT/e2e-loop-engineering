import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claudeCodeAdapter } from "@e2e-loop/adapter-claude-code";

function makeTmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loop-cc-hook-mode-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function readSettings(projectDir: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(projectDir, ".claude", "settings.json"), "utf-8"),
  ) as Record<string, unknown>;
}

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

test("Claude install: --hook-mode cli 渲染无宿主参数的 CLI hook 命令", async () => {
  const projectDir = makeTmpProject();
  try {
    await claudeCodeAdapter.install({
      projectDir,
      force: false,
      hookMode: "cli",
      cliCommand: "e2e-loop",
    });

    const cmds = allHookCommands(readSettings(projectDir));
    expect(cmds).toContain("e2e-loop hook probe-and-gate");
    expect(cmds).toContain("e2e-loop hook guard-paths");
    expect(cmds).toContain("e2e-loop hook post-task-collect");
    expect(cmds).toContain("e2e-loop hook guard-anchors");
    expect(cmds.some((c) => c.includes(" hook cc "))).toBe(false);
    expect(cmds.some((c) => c.includes(".claude/hooks/loop_engineering/"))).toBe(false);
  } finally {
    cleanup(projectDir);
  }
});

test("Claude install: local 与 cli 模式切换时不残留旧 Loop Engineering hook", async () => {
  const projectDir = makeTmpProject();
  try {
    await claudeCodeAdapter.install({ projectDir, force: false });
    await claudeCodeAdapter.install({
      projectDir,
      force: false,
      hookMode: "cli",
      cliCommand: "e2e-loop",
    });

    const cmds = allHookCommands(readSettings(projectDir));
    expect(cmds.filter((c) => c.startsWith("e2e-loop hook ")).length).toBe(4);
    expect(cmds.some((c) => c.includes(".claude/hooks/loop_engineering/"))).toBe(false);
  } finally {
    cleanup(projectDir);
  }
});
