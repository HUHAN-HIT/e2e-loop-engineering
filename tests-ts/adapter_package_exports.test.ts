import { test, expect } from "bun:test";
import claudePackageJson from "../packages/adapter-cc/package.json" with { type: "json" };
import opencodePackageJson from "../packages/adapter-oc/package.json" with { type: "json" };

type PackageJson = typeof claudePackageJson;

function rootExport(pkg: PackageJson): Record<string, string> {
  const value = pkg.exports["."];
  expect(typeof value).toBe("object");
  return value as Record<string, string>;
}

test("adapter packages expose their HostAdapter API from dist/index.mjs", () => {
  for (const pkg of [claudePackageJson, opencodePackageJson]) {
    expect(pkg.main).toBe("./dist/index.mjs");
    expect(rootExport(pkg)).toMatchObject({
      types: "./src/index.ts",
      import: "./dist/index.mjs",
      default: "./dist/index.mjs",
    });
  }
});
