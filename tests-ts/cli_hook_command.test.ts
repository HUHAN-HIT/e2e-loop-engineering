import { beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync, spawnSync } from "node:child_process";
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
});

function runCliHook(
  hookName: string,
  payload: Record<string, unknown>,
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI_BUNDLE, "hook", hookName], {
    input: JSON.stringify(payload),
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function parseDecision(stdout: string): "allow" | "block" | "defer" {
  if (!stdout.trim()) return "allow";
  const obj = JSON.parse(stdout) as Record<string, unknown>;
  if (obj.decision === "block") return "block";
  const addCtx = (obj.hookSpecificOutput as Record<string, unknown> | undefined)
    ?.additionalContext;
  return typeof addCtx === "string" ? "defer" : "allow";
}

test("CLI hook: probe-and-gate 接收 Claude Code stdin 且不需要宿主参数", () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-cli-hook-"));
  try {
    fs.mkdirSync(path.join(projectDir, "runs"), { recursive: true });
    const r = runCliHook("probe-and-gate", {
      hook_event_name: "SessionStart",
      cwd: projectDir,
    });
    expect(r.status).toBe(0);
    expect(parseDecision(r.stdout)).toBe("defer");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("CLI hook: 下划线别名行为一致", () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-cli-hook-"));
  try {
    fs.mkdirSync(path.join(projectDir, "runs"), { recursive: true });
    const r = runCliHook("probe_and_gate", {
      hook_event_name: "SessionStart",
      cwd: projectDir,
    });
    expect(r.status).toBe(0);
    expect(parseDecision(r.stdout)).toBe("defer");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("CLI hook: guard-paths 在 allowed_write_paths 内静默放行", () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-cli-hook-"));
  try {
    const runDir = path.join(projectDir, "runs", "20260628-001");
    fs.mkdirSync(path.join(runDir, "planning"), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "run-state.json"),
      JSON.stringify({
        run_id: "20260628-001",
        phase: "IMPLEMENTING",
        active_tasks: ["T1"],
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(runDir, "planning", "task-plan.yaml"),
      [
        "schema: loop-engineering.task-plan.v2",
        "complexity: simple",
        "tasks:",
        "  - id: T1",
        "    title: task T1",
        "    status: running",
        "    allowed_write_paths:",
        "      - src/**",
        "    acceptance_refs:",
        "      - AC1",
        "",
      ].join("\n"),
      "utf-8",
    );

    const r = runCliHook("guard-paths", {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: path.join(projectDir, "src", "a.ts") },
      cwd: projectDir,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("CLI hook: 未知 hook 返回错误", () => {
  const r = spawnSync(process.execPath, [CLI_BUNDLE, "hook", "missing-hook"], {
    input: "{}",
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("未知 hook");
});
