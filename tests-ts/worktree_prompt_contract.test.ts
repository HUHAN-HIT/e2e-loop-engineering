import { readFileSync } from "node:fs";
import { test, expect } from "bun:test";

function read(path: string): string {
  return readFileSync(path, "utf-8");
}

test("coordinator startup uses an isolated worktree without asking first", () => {
  const docs = [
    read("core/coordinator.md"),
    read("docs/loop-engineering-master-prompt.md"),
    read("docs/loop-engineering-prompts.md"),
  ];

  for (const doc of docs) {
    expect(doc).toContain("worktree");
    expect(doc).toContain("e2e-loop init");
    expect(doc).toContain("--worktree-mode auto");
    expect(doc).toContain("不询问");
    expect(doc).not.toContain("先让用户决定本次 run 是否使用隔离 git worktree");
  }
});

test("README documents direct worktree startup without coordinator prompting", () => {
  const readme = read("README.md");

  expect(readme).toContain("worktree");
  expect(readme).toContain("coordinator");
  expect(readme).toContain("非交互");
  expect(readme).toContain("--worktree-mode auto");
  expect(readme).toContain("不再询问");
});

test("CLI init defaults to worktree auto when coordinator omits worktree-mode", () => {
  const dryrun = read("packages/cli/src/commands/dryrun.ts");

  expect(dryrun).toContain('const mode = raw ?? "auto";');
  expect(dryrun).not.toContain('const mode = raw ?? "none";');
});
