import { existsSync } from "node:fs";
import * as fs from "node:fs";
import * as path from "node:path";
import { test, expect } from "bun:test";
import rootPackageJson from "../package.json" with { type: "json" };
import cliPackageJson from "../packages/cli/package.json" with { type: "json" };

test("workspace root is private and delegates publishing to workspace packages", () => {
  expect(rootPackageJson.name).toBe("@e2e-loop/workspace");
  expect(rootPackageJson.private).toBe(true);
  expect(rootPackageJson.scripts["publish:all"]).toContain("--workspaces");
  expect(rootPackageJson.scripts["publish:dry"]).toContain("--dry-run");
});

test("CLI package exposes the real built bin target", () => {
  expect(cliPackageJson.name).toBe("@e2e-loop/cli");
  expect(cliPackageJson.bin).toEqual({
    "e2e-loop": "dist/index.js",
  });
  expect(cliPackageJson.main).toBe("./dist/index.js");
});

test("CLI dist target exists after build", () => {
  expect(existsSync("packages/cli/dist/index.js")).toBe(true);
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
