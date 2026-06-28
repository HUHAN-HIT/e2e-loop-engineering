import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  allocateRunWorktree,
  cleanupManagedWorktree,
} from "../../packages/ssot-ts/src/worktree/allocator.js";
import {
  readWorktreeBinding,
  writeWorktreeBinding,
} from "../../packages/ssot-ts/src/worktree/binding.js";

function makeTmp(prefix = "loop-wt-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeGitRunner(responses: Record<string, string> = {}) {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const runner = (args: readonly string[], cwd: string): string => {
    calls.push({ cwd, args: [...args] });
    const key = args.join(" ");
    if (key in responses) return responses[key]!;
    return "";
  };
  return { runner, calls };
}

test("[worktree binding] write/read preserves auditable run-level workdir binding", () => {
  const root = makeTmp();
  const bindingPath = path.join(root, "runs", "20260628-001", "worktree-binding.json");
  const binding = {
    schema: "loop-engineering.worktree-binding.v1",
    mode: "created",
    owner: "loop-engineering",
    repo_root: root,
    worktree_path: path.join(root, ".worktrees", "20260628-001"),
    branch: "loop/20260628-001-worktree-allocator",
    base_ref: "HEAD",
    created_at: "2026-06-28T00:00:00.000Z",
    managed: true,
    status: "active",
  } as const;

  writeWorktreeBinding(bindingPath, binding);

  expect(readWorktreeBinding(bindingPath)).toEqual(binding);
});

test("[worktree binding] invalid schema is rejected instead of silently guessing workdir", () => {
  const root = makeTmp();
  const bindingPath = path.join(root, "worktree-binding.json");
  fs.writeFileSync(
    bindingPath,
    JSON.stringify({
      schema: "wrong",
      mode: "created",
      owner: "loop-engineering",
      repo_root: root,
      worktree_path: root,
      branch: null,
      base_ref: "HEAD",
      created_at: "2026-06-28T00:00:00.000Z",
      managed: true,
      status: "active",
    }),
    "utf-8",
  );

  expect(() => readWorktreeBinding(bindingPath)).toThrow(/worktree-binding/);
});

test("[worktree allocator] mode none keeps legacy runs root and does not create binding", () => {
  const repo = makeTmp();

  const allocation = allocateRunWorktree({
    mode: "none",
    repoCwd: repo,
    runId: "20260628-001",
  });

  expect(allocation.workdir).toBe(repo);
  expect(allocation.runsRoot).toBe(path.join(repo, "runs"));
  expect(allocation.binding).toBeNull();
});

test("[worktree allocator] always refuses default .worktrees when it is not ignored", () => {
  const repo = makeTmp();
  fs.writeFileSync(path.join(repo, ".gitignore"), "dist/\n", "utf-8");
  const { runner } = makeGitRunner({
    "rev-parse --show-toplevel": repo,
    "status --porcelain": "",
  });

  expect(() =>
    allocateRunWorktree({
      mode: "always",
      repoCwd: repo,
      runId: "20260628-001",
      git: runner,
    }),
  ).toThrow(/\.worktrees/);
});

test("[worktree allocator] always creates a new branch worktree with argv-safe git calls", () => {
  const repo = makeTmp();
  fs.writeFileSync(path.join(repo, ".gitignore"), ".worktrees/\n", "utf-8");
  const { runner, calls } = makeGitRunner({
    "rev-parse --show-toplevel": repo,
    "status --porcelain": "",
  });

  const allocation = allocateRunWorktree({
    mode: "always",
    repoCwd: repo,
    runId: "20260628-002",
    requirementSlug: "worktree allocator",
    git: runner,
  });

  expect(allocation.binding?.mode).toBe("created");
  expect(allocation.binding?.managed).toBe(true);
  expect(allocation.workdir).toBe(path.join(repo, ".worktrees", "20260628-002"));
  expect(allocation.runsRoot).toBe(path.join(allocation.workdir, "runs"));
  expect(
    calls.some((c) =>
      c.args.join(" ") ===
      `worktree add ${allocation.workdir} -b loop/20260628-002-worktree-allocator HEAD`,
    ),
  ).toBe(true);
});

test("[worktree allocator] adopt binds an existing same-repo worktree as unmanaged", () => {
  const repo = makeTmp();
  const adopted = path.join(makeTmp(), "adopted");
  fs.mkdirSync(adopted, { recursive: true });
  const common = path.join(repo, ".git");
  const { runner } = makeGitRunner({
    "rev-parse --show-toplevel": repo,
    "rev-parse --git-common-dir": common,
  });

  const allocation = allocateRunWorktree({
    mode: "adopt",
    repoCwd: repo,
    runId: "20260628-003",
    worktreePath: adopted,
    git: (args, cwd) => {
      if (cwd === adopted && args.join(" ") === "rev-parse --git-common-dir") {
        return common;
      }
      return runner(args, cwd);
    },
  });

  expect(allocation.workdir).toBe(adopted);
  expect(allocation.runsRoot).toBe(path.join(adopted, "runs"));
  expect(allocation.binding?.mode).toBe("adopted");
  expect(allocation.binding?.managed).toBe(false);
});

test("[worktree cleanup] refuses unmanaged bindings", () => {
  const repo = makeTmp();
  const binding = {
    schema: "loop-engineering.worktree-binding.v1",
    mode: "adopted",
    owner: "loop-engineering",
    repo_root: repo,
    worktree_path: path.join(repo, ".worktrees", "20260628-004"),
    branch: null,
    base_ref: "HEAD",
    created_at: "2026-06-28T00:00:00.000Z",
    managed: false,
    status: "active",
  } as const;

  expect(() => cleanupManagedWorktree(binding)).toThrow(/managed=false/);
});
