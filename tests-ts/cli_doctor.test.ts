import { beforeAll, expect, test } from "bun:test";
import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function resolveRepoRoot(): string {
  const candidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    process.cwd(),
  ];
  for (const c of candidates) {
    if (
      fs.existsSync(path.join(c, "core", "manifest.json")) &&
      fs.existsSync(path.join(c, "packages", "cli"))
    ) {
      return c;
    }
  }
  throw new Error(`无法定位仓库根: ${candidates.join(", ")}`);
}

const REPO_ROOT = resolveRepoRoot();
const CLI_BUNDLE = path.join(REPO_ROOT, "packages", "cli", "dist", "index.js");

beforeAll(() => {
  execSync("npm run build", { cwd: REPO_ROOT, stdio: "pipe" });
}, 30000);

function runDoctor(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI_BUNDLE, "doctor", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

test("CLI doctor: reports healthy TypeScript entrypoints as JSON", () => {
  const r = runDoctor(["--json"]);
  expect(r.status).toBe(0);
  expect(r.stderr).toBe("");

  const report = JSON.parse(r.stdout) as {
    ok: boolean;
    checks: Record<string, { ok: boolean; detail?: string }>;
  };
  expect(report.ok).toBe(true);
  expect(report.checks.repo_root.ok).toBe(true);
  expect(report.checks.root_shim.ok).toBe(true);
  expect(report.checks.source_entry.ok).toBe(true);
  expect(report.checks.dist_entry.ok).toBe(true);
});

test("CLI doctor: missing design document blocks preflight with nearby docs", () => {
  const r = runDoctor(["--json", "--doc", "docs/2026-06-28-reconcile-center-design.md"]);
  expect(r.status).toBe(1);
  expect(r.stderr).toBe("");

  const report = JSON.parse(r.stdout) as {
    ok: boolean;
    checks: Record<string, { ok: boolean; detail?: string }>;
    nearby_docs: string[];
  };
  expect(report.ok).toBe(false);
  expect(report.checks.document_exists.ok).toBe(false);
  expect(report.checks.document_exists.detail).toContain(
    "docs/2026-06-28-reconcile-center-design.md",
  );
  expect(report.checks.root_shim.ok).toBe(true);
  expect(report.nearby_docs.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// 目标项目态 (target-project): doctor 跑在【安装了 .claude 资产】的消费方项目,
// 而非 loop-engineering 源码仓库。此时不该再核对源码仓库的构建产物 (那些本就不该
// 存在), 而应核对 skill/agents/hooks 装齐、且 hook 命令走 CLI 形式 (规避 .mjs 路径依赖)。
// ---------------------------------------------------------------------------

const AGENT_FILES = [
  "clarification-finder.md",
  "implementation-worker.md",
  "plan-agent.md",
  "red-team-reviewer.md",
];

/** 生成 settings.json 文本。pathForm=true 时用 .mjs 路径形式 (应被 doctor 判 fail)。 */
function renderHookSettings(pathForm: boolean): string {
  const cmd = (dash: string, under: string): string =>
    pathForm
      ? `node .claude/hooks/loop_engineering/${under}.mjs`
      : `e2e-loop hook ${dash}`;
  return JSON.stringify(
    {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: cmd("probe-and-gate", "probe_and_gate") }] },
        ],
        PreToolUse: [
          {
            matcher: "Write|Edit",
            hooks: [{ type: "command", command: cmd("guard-paths", "guard_paths") }],
          },
        ],
        PostToolUse: [
          {
            matcher: "Task",
            hooks: [{ type: "command", command: cmd("post-task-collect", "post_task_collect") }],
          },
        ],
        Stop: [
          { hooks: [{ type: "command", command: cmd("guard-anchors", "guard_anchors") }] },
        ],
      },
    },
    null,
    2,
  );
}

/**
 * 造一个目标项目骨架 (临时目录, 必须落在 REPO_ROOT 之外, 否则 findRepoRoot 向上
 * 行走会误命中本仓库的 core/manifest.json)。
 */
function makeTargetProject(
  opts: { pathForm?: boolean; missingAgent?: string; noSkill?: boolean } = {},
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-doctor-"));
  const claude = path.join(dir, ".claude");
  if (!opts.noSkill) {
    const skillDir = path.join(claude, "skills", "loop-engineering");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# loop-engineering skill\n");
  }
  const agentsDir = path.join(claude, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const a of AGENT_FILES) {
    if (a === opts.missingAgent) continue;
    fs.writeFileSync(path.join(agentsDir, a), `# ${a}\n`);
  }
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, "settings.json"), renderHookSettings(opts.pathForm ?? false));
  return dir;
}

test("CLI doctor: 目标项目态资产完整 → ok (mode=target-project)", () => {
  const dir = makeTargetProject();
  try {
    const r = runDoctor(["--json", "--project-dir", dir]);
    expect(r.stderr).toBe("");
    const report = JSON.parse(r.stdout) as {
      ok: boolean;
      mode: string;
      checks: Record<string, { ok: boolean; detail?: string }>;
    };
    expect(report.mode).toBe("target-project");
    expect(report.checks.skill_installed.ok).toBe(true);
    expect(report.checks.agents_installed.ok).toBe(true);
    expect(report.checks.hooks_wired.ok).toBe(true);
    expect(report.checks.hooks_cli_form.ok).toBe(true);
    expect(report.ok).toBe(true);
    expect(r.status).toBe(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI doctor: 目标项目态 hook 用 .mjs 路径形式 → hooks_cli_form fail", () => {
  const dir = makeTargetProject({ pathForm: true });
  try {
    const r = runDoctor(["--json", "--project-dir", dir]);
    const report = JSON.parse(r.stdout) as {
      ok: boolean;
      mode: string;
      checks: Record<string, { ok: boolean; detail?: string }>;
    };
    expect(report.mode).toBe("target-project");
    expect(report.checks.hooks_wired.ok).toBe(true); // 接线在, 只是形式不对
    expect(report.checks.hooks_cli_form.ok).toBe(false);
    expect(report.ok).toBe(false);
    expect(r.status).toBe(1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI doctor: 目标项目态缺 subagent → agents_installed fail", () => {
  const dir = makeTargetProject({ missingAgent: "plan-agent.md" });
  try {
    const r = runDoctor(["--json", "--project-dir", dir]);
    const report = JSON.parse(r.stdout) as {
      ok: boolean;
      checks: Record<string, { ok: boolean; detail?: string }>;
    };
    expect(report.checks.agents_installed.ok).toBe(false);
    expect(report.checks.agents_installed.detail).toContain("plan-agent.md");
    expect(report.ok).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI doctor: 未知态 (既非源码仓库也无 .claude 资产) → blocked", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-doctor-empty-"));
  try {
    const r = runDoctor(["--json", "--project-dir", dir]);
    const report = JSON.parse(r.stdout) as { ok: boolean; mode: string };
    expect(report.mode).toBe("unknown");
    expect(report.ok).toBe(false);
    expect(r.status).toBe(1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
