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

test("[worktree allocator] auto creates an isolated worktree even when the base worktree is dirty", () => {
  const repo = makeTmp();
  fs.writeFileSync(path.join(repo, ".gitignore"), ".worktrees/\n", "utf-8");
  const { runner, calls } = makeGitRunner({
    "rev-parse --show-toplevel": repo,
    "status --porcelain": " M README.md",
  });

  const allocation = allocateRunWorktree({
    mode: "auto",
    repoCwd: repo,
    runId: "20260628-005",
    requirementSlug: "dirty base",
    git: runner,
  });

  expect(allocation.binding?.mode).toBe("created");
  expect(allocation.workdir).toBe(path.join(repo, ".worktrees", "20260628-005"));
  expect(
    calls.some((c) =>
      c.args.join(" ") ===
      `worktree add ${allocation.workdir} -b loop/20260628-005-dirty-base HEAD`,
    ),
  ).toBe(true);
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

test("[worktree allocator] passes hook-asset consistency check when referenced .mjs exists", () => {
  // 正向: 主仓 settings.json 注册了本地 .mjs hook 且对应文件齐全 → 拷进 worktree 后校验通过, 不抛。
  const repo = makeTmp();
  fs.writeFileSync(path.join(repo, ".gitignore"), ".worktrees/\n", "utf-8");

  // 在主仓装好 loop 的 .claude 资产: settings.json 引用 guard_anchors.mjs, 且该 .mjs 真实存在。
  const hooksDir = path.join(repo, ".claude", "hooks", "loop_engineering");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, "guard_anchors.mjs"), "// 空 hook 占位\n", "utf-8");
  fs.writeFileSync(
    path.join(repo, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ command: "node .claude/hooks/loop_engineering/guard_anchors.mjs" }] },
        ],
      },
    }),
    "utf-8",
  );

  const { runner } = makeGitRunner({
    "rev-parse --show-toplevel": repo,
    "status --porcelain": "",
  });

  const allocation = allocateRunWorktree({
    mode: "always",
    repoCwd: repo,
    runId: "20260628-006",
    requirementSlug: "hooks consistent",
    git: runner,
  });

  // 不抛, 且 worktree 内确实落了对应 .mjs。
  expect(allocation.binding?.mode).toBe("created");
  expect(
    fs.existsSync(
      path.join(allocation.workdir, ".claude", "hooks", "loop_engineering", "guard_anchors.mjs"),
    ),
  ).toBe(true);
});

test("[worktree allocator] fail-closed when settings.json references a missing .mjs hook", () => {
  // fail-closed: 主仓 settings.json 引用 .mjs 但文件缺失 → 拷进 worktree 后校验失败 → 抛错, 拒绝产出无门 worktree。
  const repo = makeTmp();
  fs.writeFileSync(path.join(repo, ".gitignore"), ".worktrees/\n", "utf-8");

  // 只写 settings.json (引用 guard_anchors.mjs), 故意不建对应 .mjs 文件。
  fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ command: "node .claude/hooks/loop_engineering/guard_anchors.mjs" }] },
        ],
      },
    }),
    "utf-8",
  );

  const { runner } = makeGitRunner({
    "rev-parse --show-toplevel": repo,
    "status --porcelain": "",
  });

  expect(() =>
    allocateRunWorktree({
      mode: "always",
      repoCwd: repo,
      runId: "20260628-007",
      requirementSlug: "hooks missing",
      git: runner,
    }),
  ).toThrow(/装配不一致|拒绝产出无门 worktree/);
});

// ---------------------------------------------------------------------------
// 改动① (worktree-only 隔离) 测试: settings 过滤 / 根 marker / 不抄 .opencode
//
// 现有 allocator 测试的 makeGitRunner 把 `git worktree add` 设为 mock —— worktree 目录
// 不会被真建。要验证 syncProjectHookConfig 的拷贝/过滤结果, 需要一个"会真建 worktree 目录"
// 的 git runner。下面的 makeRealisticGitRunner 在收到 `worktree add <path> ...` 时真建该目录,
// 让后续拷贝有真实落点。
// ---------------------------------------------------------------------------

function makeRealisticGitRunner(repo: string, responses: Record<string, string> = {}) {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const runner = (args: readonly string[], cwd: string): string => {
    calls.push({ cwd, args: [...args] });
    // `worktree add <path> -b <branch> <ref>` → 真建目录, 让 syncProjectHookConfig 有落点。
    if (args[0] === "worktree" && args[1] === "add" && typeof args[2] === "string") {
      fs.mkdirSync(args[2], { recursive: true });
    }
    const key = args.join(" ");
    if (key in responses) return responses[key]!;
    if (key === "rev-parse --show-toplevel") return repo;
    if (key === "status --porcelain") return "";
    return "";
  };
  return { runner, calls };
}

/** 在主仓装好一份完整的 loop .claude 资产 (settings + 4 hook .mjs + skill/agent)。 */
function seedLoopClaudeAssets(repo: string, userHookCommand?: string): void {
  const hooksDir = path.join(repo, ".claude", "hooks", "loop_engineering");
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const name of [
    "probe_and_gate",
    "guard_paths",
    "post_task_collect",
    "guard_anchors",
  ]) {
    fs.writeFileSync(path.join(hooksDir, `${name}.mjs`), "// 占位 hook\n", "utf-8");
  }
  // skill + agent 资产 (worktree 应一并带过去)
  fs.mkdirSync(path.join(repo, ".claude", "skills", "loop-engineering"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".claude", "skills", "loop-engineering", "SKILL.md"),
    "# SKILL\n",
    "utf-8",
  );
  fs.mkdirSync(path.join(repo, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".claude", "agents", "plan-agent.md"), "# plan\n", "utf-8");

  // settings.json: loop 的 4 个 cli-mode hook + (可选) 一个用户自定义 hook
  const loopHooks: Record<string, unknown[]> = {
    SessionStart: [{ hooks: [{ command: "e2e-loop hook probe-and-gate" }] }],
    PreToolUse: [{ matcher: "Write|Edit", hooks: [{ command: "e2e-loop hook guard-paths" }] }],
    PostToolUse: [{ matcher: "Task", hooks: [{ command: "e2e-loop hook post-task-collect" }] }],
    Stop: [{ hooks: [{ command: "e2e-loop hook guard-anchors" }] }],
  };
  if (userHookCommand) {
    // 用户在 PreToolUse 上挂了自己的脚本 (与 loop 的 guard-paths 同事件并存)。
    (loopHooks.PreToolUse as unknown[]).push({
      matcher: "Write|Edit",
      hooks: [{ command: userHookCommand }],
    });
  }
  fs.writeFileSync(
    path.join(repo, ".claude", "settings.json"),
    JSON.stringify({ permissions: { allow: ["Bash"] }, hooks: loopHooks }, null, 2),
    "utf-8",
  );
}

test("[worktree allocator] worktree settings 只保留 loop hook, 剥掉用户自定义 hook", () => {
  // 测试点 1: 主工程 settings.json 含用户自定义 hook + loop hook → 过滤/同步后 worktree
  // settings 只含 loop hook, 不含用户 hook; 非 hooks 字段 (permissions) 原样保留。
  const repo = makeTmp();
  fs.writeFileSync(path.join(repo, ".gitignore"), ".worktrees/\n", "utf-8");
  const userHook = "node ./scripts/user-precommit.mjs";
  seedLoopClaudeAssets(repo, userHook);

  const { runner } = makeRealisticGitRunner(repo);
  const allocation = allocateRunWorktree({
    mode: "always",
    repoCwd: repo,
    runId: "20260629-010",
    requirementSlug: "settings filter",
    git: runner,
  });

  const wtSettings = JSON.parse(
    fs.readFileSync(path.join(allocation.workdir, ".claude", "settings.json"), "utf-8"),
  );
  // 收集 worktree settings 里所有 hook command
  const cmds: string[] = [];
  for (const groups of Object.values(wtSettings.hooks as Record<string, unknown>)) {
    for (const g of groups as Array<{ hooks?: Array<{ command?: string }> }>) {
      for (const h of g.hooks ?? []) {
        if (typeof h.command === "string") cmds.push(h.command);
      }
    }
  }
  // 用户 hook 不应出现
  expect(cmds).not.toContain(userHook);
  // 4 个 loop hook 都在
  expect(cmds).toContain("e2e-loop hook probe-and-gate");
  expect(cmds).toContain("e2e-loop hook guard-paths");
  expect(cmds).toContain("e2e-loop hook post-task-collect");
  expect(cmds).toContain("e2e-loop hook guard-anchors");
  // 非 hooks 字段原样保留
  expect(wtSettings.permissions).toEqual({ allow: ["Bash"] });
});

test("[worktree allocator] local .mjs 模式的 loop hook 也被识别保留", () => {
  // loop hook 判据要同时认 CLI 模式与 local .mjs 路径模式。
  const repo = makeTmp();
  fs.writeFileSync(path.join(repo, ".gitignore"), ".worktrees/\n", "utf-8");
  // 装 local .mjs 模式资产
  const hooksDir = path.join(repo, ".claude", "hooks", "loop_engineering");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, "guard_anchors.mjs"), "// 占位\n", "utf-8");
  fs.writeFileSync(
    path.join(repo, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ command: "node .claude/hooks/loop_engineering/guard_anchors.mjs" }] }],
        PreToolUse: [{ hooks: [{ command: "node ./scripts/user.mjs" }] }],
      },
    }),
    "utf-8",
  );

  const { runner } = makeRealisticGitRunner(repo);
  const allocation = allocateRunWorktree({
    mode: "always",
    repoCwd: repo,
    runId: "20260629-011",
    requirementSlug: "local mjs filter",
    git: runner,
  });

  const wtSettings = JSON.parse(
    fs.readFileSync(path.join(allocation.workdir, ".claude", "settings.json"), "utf-8"),
  );
  // local .mjs loop hook 保留
  expect(wtSettings.hooks.Stop).toBeDefined();
  // 用户 PreToolUse hook 被剥掉 → 该事件空了应清掉
  expect(wtSettings.hooks.PreToolUse).toBeUndefined();
});

test("[worktree allocator] 创建后 worktree 根写了 .loop-engineering/worktree.json marker", () => {
  // 测试点 2: allocator 创建 worktree 后, worktree 根存在合法 marker, owner/run_id 正确。
  const repo = makeTmp();
  fs.writeFileSync(path.join(repo, ".gitignore"), ".worktrees/\n", "utf-8");
  seedLoopClaudeAssets(repo);

  const { runner } = makeRealisticGitRunner(repo);
  const allocation = allocateRunWorktree({
    mode: "always",
    repoCwd: repo,
    runId: "20260629-012",
    requirementSlug: "marker write",
    git: runner,
    now: new Date("2026-06-29T08:00:00.000Z"),
  });

  const markerPath = path.join(allocation.workdir, ".loop-engineering", "worktree.json");
  expect(fs.existsSync(markerPath)).toBe(true);
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
  expect(marker.schema).toBe("loop-engineering.worktree-marker.v1");
  expect(marker.owner).toBe("loop-engineering");
  expect(marker.run_id).toBe("20260629-012");
  expect(marker.created_at).toBe("2026-06-29T08:00:00.000Z");
});

test("[worktree allocator] .opencode 不被抄进 CC worktree", () => {
  // 测试点 4: worktree-only 是 CC 形态, OC 资产不抄。
  const repo = makeTmp();
  fs.writeFileSync(path.join(repo, ".gitignore"), ".worktrees/\n", "utf-8");
  seedLoopClaudeAssets(repo);
  // 主仓有 .opencode 资产
  fs.mkdirSync(path.join(repo, ".opencode", "plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".opencode", "plugin", "loop.js"),
    "// oc plugin\n",
    "utf-8",
  );

  const { runner } = makeRealisticGitRunner(repo);
  const allocation = allocateRunWorktree({
    mode: "always",
    repoCwd: repo,
    runId: "20260629-013",
    requirementSlug: "no opencode",
    git: runner,
  });

  // .opencode 不应出现在 worktree
  expect(fs.existsSync(path.join(allocation.workdir, ".opencode"))).toBe(false);
  // .claude 仍在 (skill/agent/hook 资产带过去了)
  expect(fs.existsSync(path.join(allocation.workdir, ".claude", "settings.json"))).toBe(true);
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

// ---------------------------------------------------------------------------
// 缺口 B 修复 (2026-06-30): existing/adopt 分支也写根 marker, 否则 worktreeGate 永久拒绝。
// ---------------------------------------------------------------------------

test("[worktree allocator][缺口B] adopt 在被采纳 worktree 根写 marker", () => {
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
    runId: "20260630-001",
    worktreePath: adopted,
    now: new Date("2026-06-30T00:00:00.000Z"),
    git: (args, cwd) => {
      if (cwd === adopted && args.join(" ") === "rev-parse --git-common-dir") {
        return common;
      }
      return runner(args, cwd);
    },
  });

  const markerPath = path.join(adopted, ".loop-engineering", "worktree.json");
  expect(fs.existsSync(markerPath)).toBe(true);
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
  expect(marker.schema).toBe("loop-engineering.worktree-marker.v1");
  expect(marker.owner).toBe("loop-engineering");
  expect(marker.run_id).toBe("20260630-001");
  expect(allocation.workdir).toBe(adopted);
});

test("[worktree allocator][缺口B] auto 命中已在 linked worktree → existing 分支在根写 marker", () => {
  const repo = makeTmp();
  // linked worktree 的标志: .git 是文件 (不是目录)。
  fs.writeFileSync(
    path.join(repo, ".git"),
    "gitdir: /somewhere/.git/worktrees/wt\n",
    "utf-8",
  );
  const { runner } = makeGitRunner({
    "rev-parse --show-toplevel": repo,
  });

  const allocation = allocateRunWorktree({
    mode: "auto",
    repoCwd: repo,
    runId: "20260630-002",
    now: new Date("2026-06-30T00:00:00.000Z"),
    git: runner,
  });

  expect(allocation.binding?.mode).toBe("existing");
  expect(allocation.workdir).toBe(repo);
  const markerPath = path.join(repo, ".loop-engineering", "worktree.json");
  expect(fs.existsSync(markerPath)).toBe(true);
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
  expect(marker.run_id).toBe("20260630-002");
});

test("[worktree allocator][缺口B] adopt 目标根已绑别的 run → 拒绝", () => {
  const repo = makeTmp();
  const adopted = path.join(makeTmp(), "adopted");
  fs.mkdirSync(path.join(adopted, ".loop-engineering"), { recursive: true });
  fs.writeFileSync(
    path.join(adopted, ".loop-engineering", "worktree.json"),
    JSON.stringify({
      schema: "loop-engineering.worktree-marker.v1",
      owner: "loop-engineering",
      run_id: "20260601-999",
      created_at: "2026-06-01T00:00:00.000Z",
    }),
    "utf-8",
  );
  const common = path.join(repo, ".git");
  const { runner } = makeGitRunner({
    "rev-parse --show-toplevel": repo,
    "rev-parse --git-common-dir": common,
  });

  expect(() =>
    allocateRunWorktree({
      mode: "adopt",
      repoCwd: repo,
      runId: "20260630-003",
      worktreePath: adopted,
      git: (args, cwd) => {
        if (cwd === adopted && args.join(" ") === "rev-parse --git-common-dir") {
          return common;
        }
        return runner(args, cwd);
      },
    }),
  ).toThrow(/一个 worktree 只跑一个 run|已绑定 run/);
});
