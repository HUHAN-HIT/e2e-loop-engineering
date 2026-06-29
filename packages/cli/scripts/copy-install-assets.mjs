import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(here, "..");
const repoRoot = path.resolve(cliRoot, "..", "..");
const assets = path.join(cliRoot, "dist", "assets");

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dst, ent.name);
    if (ent.isDirectory()) {
      copyDir(from, to);
    } else if (ent.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

fs.rmSync(assets, { recursive: true, force: true });
fs.mkdirSync(assets, { recursive: true });

copyDir(path.join(repoRoot, "core"), path.join(assets, "core"));

const ccDist = path.join(assets, "packages", "adapter-cc", "dist");
fs.mkdirSync(ccDist, { recursive: true });
for (const name of [
  "probe_and_gate.mjs",
  "guard_paths.mjs",
  "post_task_collect.mjs",
  "guard_anchors.mjs",
]) {
  fs.copyFileSync(path.join(repoRoot, "packages", "adapter-cc", "dist", name), path.join(ccDist, name));
}

const ocDist = path.join(assets, "packages", "adapter-oc", "dist");
fs.mkdirSync(ocDist, { recursive: true });
fs.copyFileSync(
  path.join(repoRoot, "packages", "adapter-oc", "dist", "loop-engineering.js"),
  path.join(ocDist, "loop-engineering.js"),
);
