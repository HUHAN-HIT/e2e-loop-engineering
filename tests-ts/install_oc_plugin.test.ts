/**
 * OpenCode adapter 安装 plugin 集成测试 (P3 go/no-go 门禁的一部分)。
 *
 * 目的: 验证 adapter-opencode 的 install/dryRun/uninstall 正确处理 OC plugin bundle:
 *   - install: 把 packages/adapter-oc/dist/loop-engineering.js 复制到目标
 *     .opencode/plugins/loop-engineering.js, 非空且是合法 ESM (含命名导出 LoopEngineeringPlugin)。
 *   - dryRun: manifest 列出 plugin 条目 (source=adapter)。
 *   - uninstall: 删 plugin 文件, 不误删用户在 .opencode/plugins/ 的自建 plugin。
 *
 * 前置: 需先 `npm run build:adapter-oc-plugin` 产出 dist。dist 缺失时 plugin 落盘条目会被
 * "源缺失即跳过", 此时跳过强断言 (用 dist 是否存在做条件)。CI/验证流程会保证 dist 在场。
 *
 * 每个用例独立临时 projectDir, 结束清理。
 */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { opencodeAdapter } from "@e2e-loop/adapter-opencode";

const PLUGIN_REL = ".opencode/plugins/loop-engineering.js";

/** 定位 plugin bundle 源路径 (与 install.ts pluginBundleSrc 一致)。 */
function pluginDistPath(): string {
  // 本测试文件位于 <repo>/tests-ts/, 向上一级即仓库根。
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(
    here,
    "..",
    "packages",
    "adapter-oc",
    "dist",
    "loop-engineering.js",
  );
}

/** dist 是否已构建 (决定强断言是否生效)。 */
function distBuilt(): boolean {
  return fs.existsSync(pluginDistPath());
}

function makeTmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loop-oc-plugin-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 用例 1: install 把 plugin 落到 .opencode/plugins/loop-engineering.js, 非空且合法 ESM
// ---------------------------------------------------------------------------
test("install: plugin 落盘 .opencode/plugins/loop-engineering.js (非空, 合法 ESM 命名导出)", async () => {
  const projectDir = makeTmpProject();
  try {
    const result = await opencodeAdapter.install({ projectDir, force: false });

    if (!distBuilt()) {
      // dist 未构建: install 应"源缺失即跳过", 不报错; plugin 条目进 skippedFiles。
      expect(result.skippedFiles).toContain(PLUGIN_REL);
      return;
    }

    // dist 已构建: plugin 应落盘
    expect(result.writtenFiles).toContain(PLUGIN_REL);
    const pluginPath = path.join(projectDir, PLUGIN_REL);
    expect(fs.existsSync(pluginPath)).toBe(true);

    const content = fs.readFileSync(pluginPath, "utf-8");
    // 非空
    expect(content.length).toBeGreaterThan(0);
    // 合法 ESM: 含命名导出 LoopEngineeringPlugin (tsup 产出形如 export { ... LoopEngineeringPlugin ... })
    expect(content).toContain("LoopEngineeringPlugin");
    expect(/export\s*\{/.test(content)).toBe(true);
    // 自包含: 不应残留 bare @e2e-loop import (noExternal 全打进)
    expect(/from\s*["']@e2e-loop/.test(content)).toBe(false);
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 2: 落盘的 plugin 能被 node 作为 ESM 动态 import, 导出 function
// ---------------------------------------------------------------------------
test("install: 落盘 plugin 能被动态 import 且 LoopEngineeringPlugin 是 function", async () => {
  if (!distBuilt()) return; // dist 未构建跳过
  const projectDir = makeTmpProject();
  try {
    await opencodeAdapter.install({ projectDir, force: false });
    const pluginPath = path.join(projectDir, PLUGIN_REL);
    const url = "file://" + pluginPath.replace(/\\/g, "/");
    const mod = (await import(url)) as Record<string, unknown>;
    expect(typeof mod.LoopEngineeringPlugin).toBe("function");
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 3: dryRun manifest 含 plugin 条目 (source=adapter)
// ---------------------------------------------------------------------------
test("dryRun: manifest 含 plugin 条目 (source=adapter)", async () => {
  const projectDir = makeTmpProject();
  try {
    const manifest = await opencodeAdapter.dryRun({ projectDir, force: false });
    const entry = manifest.files.find((f) => f.path === PLUGIN_REL);
    expect(entry).toBeDefined();
    expect(entry?.source).toBe("adapter");
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 4: uninstall 删 plugin 文件
// ---------------------------------------------------------------------------
test("uninstall: 删 .opencode/plugins/loop-engineering.js", async () => {
  if (!distBuilt()) return; // 无 dist 则没装 plugin, 跳过
  const projectDir = makeTmpProject();
  try {
    await opencodeAdapter.install({ projectDir, force: false });
    const pluginPath = path.join(projectDir, PLUGIN_REL);
    expect(fs.existsSync(pluginPath)).toBe(true);

    const result = await opencodeAdapter.uninstall!(projectDir);
    expect(fs.existsSync(pluginPath)).toBe(false);
    expect(result.removedFiles).toContain(PLUGIN_REL);
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 5: uninstall 不误删用户在 .opencode/plugins/ 的自建 plugin
// ---------------------------------------------------------------------------
test("uninstall: 保留用户在 .opencode/plugins/ 的自建 plugin", async () => {
  const projectDir = makeTmpProject();
  try {
    await opencodeAdapter.install({ projectDir, force: false });
    // 用户在 plugins/ 下放自己的 plugin
    const userPlugin = path.join(
      projectDir,
      ".opencode",
      "plugins",
      "my-plugin.js",
    );
    fs.mkdirSync(path.dirname(userPlugin), { recursive: true });
    fs.writeFileSync(userPlugin, "export const X = 1;\n", "utf-8");

    await opencodeAdapter.uninstall!(projectDir);

    // 用户自建 plugin 保留
    expect(fs.existsSync(userPlugin)).toBe(true);
    expect(fs.readFileSync(userPlugin, "utf-8")).toContain("export const X");
  } finally {
    cleanup(projectDir);
  }
});

// ---------------------------------------------------------------------------
// 用例 6: 幂等 — 第二次 install(force:false) plugin 进 skippedFiles (copy 类已存在则跳过)
// ---------------------------------------------------------------------------
test("install: 幂等 — 第二次 force:false plugin 进 skippedFiles", async () => {
  if (!distBuilt()) return;
  const projectDir = makeTmpProject();
  try {
    await opencodeAdapter.install({ projectDir, force: false });
    const second = await opencodeAdapter.install({ projectDir, force: false });
    expect(second.skippedFiles).toContain(PLUGIN_REL);
    expect(second.writtenFiles).not.toContain(PLUGIN_REL);
  } finally {
    cleanup(projectDir);
  }
});
