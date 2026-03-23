#!/usr/bin/env bun
/**
 * Create a GitHub release and upload the archive.
 *
 * Reads version from package.json, tags the current commit, creates
 * a GH release, and uploads the matching build artifact.
 *
 * Usage:
 *   bun scripts/publish-release.ts           # build + publish
 *   bun scripts/publish-release.ts --no-build # publish existing archive only
 */
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const pkg = await Bun.file(resolve(root, "package.json")).json();
const version: string = pkg.version;
const tag = `v${version}`;
const platform = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
const arch = process.arch === "arm64" ? "arm64" : "x64";
const archiveName = `flmux-${version}-${platform}-${arch}.tar.gz`;
const archivePath = resolve(root, "build", archiveName);

const noBuild = process.argv.includes("--no-build");

// Step 1: Build release archive (unless --no-build)
if (!noBuild) {
  console.log("Building release archive...");
  const build = Bun.spawnSync(["bun", resolve(import.meta.dir, "build-release.ts")], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (build.exitCode !== 0) process.exit(1);
}

// Verify archive exists
const file = Bun.file(archivePath);
if (!(await file.exists())) {
  console.error(`Archive not found: build/${archiveName}`);
  console.error("Run without --no-build or run build-release.ts first.");
  process.exit(1);
}

// Step 2: Tag
console.log(`Tagging ${tag}...`);
run(["git", "tag", tag]);
run(["git", "push", "origin", tag]);

// Step 3: Create release and upload
console.log(`Creating GitHub release ${tag}...`);
const gh = Bun.spawnSync(
  ["gh", "release", "create", tag, "--title", tag, "--generate-notes", archivePath],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
if (gh.exitCode !== 0) {
  console.error("gh release create failed");
  process.exit(1);
}

console.log(`Released ${tag} with ${archiveName}`);

function run(cmd: string[]) {
  const r = Bun.spawnSync(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) {
    console.error(`Command failed: ${cmd.join(" ")}`);
    process.exit(1);
  }
}
