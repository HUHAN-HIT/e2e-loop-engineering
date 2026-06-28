import { existsSync } from "node:fs";
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
