import { readFileSync } from "node:fs";
import { test, expect } from "bun:test";

function read(path: string): string {
  return readFileSync(path, "utf-8");
}

test("coordinator prompts require asking the user for worktree mode before init", () => {
  const docs = [
    read("core/coordinator.md"),
    read("docs/loop-engineering-master-prompt.md"),
    read("docs/loop-engineering-prompts.md"),
  ];

  for (const doc of docs) {
    expect(doc).toContain("worktree");
    expect(doc).toContain("AskUserQuestion");
    expect(doc).toContain("e2e-loop init");
    expect(doc).toContain("--worktree-mode auto");
    expect(doc).toContain("--worktree-mode none");
    expect(doc).toContain("--worktree-mode always");
  }
});

test("README documents coordinator-level worktree selection without CLI prompting", () => {
  const readme = read("README.md");

  expect(readme).toContain("worktree");
  expect(readme).toContain("coordinator");
  expect(readme).toContain("非交互");
  expect(readme).toContain("--worktree-mode auto");
  expect(readme).toContain("--worktree-mode none");
});
