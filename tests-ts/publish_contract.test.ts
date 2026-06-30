import { existsSync } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { test, expect } from "bun:test";
import rootPackageJson from "../package.json" with { type: "json" };
import cliPackageJson from "../packages/cli/package.json" with { type: "json" };
import sharedPackageJson from "../packages/shared/package.json" with { type: "json" };
import ssotPackageJson from "../packages/ssot-ts/package.json" with { type: "json" };

test("workspace root is private and delegates publishing to workspace packages", () => {
  expect(rootPackageJson.name).toBe("@e2e-loop/workspace");
  expect(rootPackageJson.private).toBe(true);
  expect(rootPackageJson.scripts["publish:all"]).toContain("--workspaces");
  expect(rootPackageJson.scripts["publish:dry"]).toContain("--dry-run");
});

test("CLI package exposes the real built bin target", () => {
  expect(cliPackageJson.name).toBe("e2e-loop");
  expect(cliPackageJson.bin).toEqual({
    "e2e-loop": "dist/index.js",
  });
  expect(cliPackageJson.main).toBe("./dist/index.js");
});

test("CLI dist target exists after build", () => {
  expect(existsSync("packages/cli/dist/index.js")).toBe(true);
});

test("CLI dist can install outside the source checkout", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-loop-pack-"));
  try {
    const pkgDir = path.join(tmp, "pkg");
    const targetDir = path.join(tmp, "target");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.copyFileSync(
      path.join(process.cwd(), "packages", "cli", "package.json"),
      path.join(pkgDir, "package.json"),
    );
    fs.cpSync(path.join(process.cwd(), "packages", "cli", "dist"), path.join(pkgDir, "dist"), {
      recursive: true,
    });

    for (const host of ["cc", "oc"] as const) {
      const out = execFileSync(
        "node",
        [
          path.join(pkgDir, "dist", "index.js"),
          "install",
          "--host",
          host,
          "--project-dir",
          targetDir,
          "--dry-run",
        ],
        { cwd: pkgDir, encoding: "utf-8" },
      );
      expect(out).toContain("[dry-run] 计划落盘");
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("library workspace packages publish runnable dist entrypoints", () => {
  expect(sharedPackageJson.main).toBe("./dist/index.js");
  expect(sharedPackageJson.types).toBe("./dist/index.d.ts");
  expect(sharedPackageJson.exports["."]).toEqual({
    types: "./dist/index.d.ts",
    import: "./dist/index.js",
    default: "./dist/index.js",
  });
  expect(sharedPackageJson.files).toContain("dist");

  expect(ssotPackageJson.main).toBe("./dist/index.js");
  expect(ssotPackageJson.types).toBe("./dist/index.d.ts");
  expect(ssotPackageJson.exports["."]).toEqual({
    types: "./dist/index.d.ts",
    import: "./dist/index.js",
    default: "./dist/index.js",
  });
  expect(ssotPackageJson.exports["./schema"]).toEqual({
    types: "./dist/schema/index.d.ts",
    import: "./dist/schema/index.js",
    default: "./dist/schema/index.js",
  });
  expect(ssotPackageJson.files).toContain("dist");

  execFileSync("node", ["-e", "import('./packages/shared/dist/index.js')"], {
    cwd: process.cwd(),
    stdio: "pipe",
  });
  execFileSync("node", ["-e", "import('./packages/ssot-ts/dist/index.js')"], {
    cwd: process.cwd(),
    stdio: "pipe",
  });
});

const WORKSPACE_PACKAGE_JSONS = [
  "package.json",
  "packages/adapter-cc/package.json",
  "packages/adapter-oc/package.json",
  "packages/cli/package.json",
  "packages/shared/package.json",
  "packages/ssot-ts/package.json",
] as const;

test("all workspace package manifests are valid JSON", () => {
  const failures: string[] = [];

  for (const rel of WORKSPACE_PACKAGE_JSONS) {
    const text = fs.readFileSync(path.join(process.cwd(), rel), "utf-8");
    try {
      const parsed = JSON.parse(text) as { name?: unknown; version?: unknown };
      if (typeof parsed.name !== "string" || parsed.name.length === 0) {
        failures.push(`${rel}: missing string name`);
      }
      if (typeof parsed.version !== "string" || parsed.version.length === 0) {
        failures.push(`${rel}: missing string version`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${rel}: ${msg}`);
    }
  }

  expect(failures).toEqual([]);
});
