/**
 * Publish contract for the root npm package.
 *
 * The public package is `e2e-loop`, not the internal workspace packages.
 * It ships a stable root bin wrapper, the bundled CLI, and the runtime assets
 * the installer resolves relative to the package root after a global install.
 */
import { readFileSync } from "node:fs";
import { test, expect } from "bun:test";
import rootPackageJson from "../package.json" with { type: "json" };

const publishFiles = [
  "bin/",
  "core/",
  "packages/cli/dist/index.mjs",
  "packages/adapter-cc/dist/guard_anchors.mjs",
  "packages/adapter-cc/dist/guard_paths.mjs",
  "packages/adapter-cc/dist/post_task_collect.mjs",
  "packages/adapter-cc/dist/probe_and_gate.mjs",
  "packages/adapter-oc/dist/loop-engineering.js",
  "README.md",
];

test("root package is publishable as the global e2e-loop CLI", () => {
  expect(rootPackageJson.name).toBe("e2e-loop");
  expect(rootPackageJson.private).not.toBe(true);
  expect(rootPackageJson.bin).toEqual({
    "e2e-loop": "bin/e2e-loop",
  });
  expect(rootPackageJson.main).toBe("./packages/cli/dist/index.mjs");
});

test("root bin wrapper starts with a valid shebang", () => {
  const wrapper = readFileSync("bin/e2e-loop");
  expect(wrapper.subarray(0, 2).toString("utf-8")).toBe("#!");
  expect(wrapper.toString("utf-8")).toContain(
    'import "../packages/cli/dist/index.mjs";',
  );
});

test("root prerelease publishes under the alpha dist-tag", () => {
  expect(rootPackageJson.version).toContain("-");
  expect(rootPackageJson.publishConfig).toEqual({
    tag: "alpha",
  });
  expect(readFileSync(".npmrc", "utf-8")).toContain("tag=alpha");
});

test("root package whitelists only the runtime publish surface", () => {
  expect(rootPackageJson.files).toEqual(publishFiles);
  expect(rootPackageJson.dependencies).toBeUndefined();
});
