#!/usr/bin/env bun
/**
 * Build a portable release archive for the current platform.
 *
 * Reads version from package.json, runs electrobun build, then creates
 * a tar.gz with files at archive root (no wrapper folder).
 *
 * Output: build/flmux-{version}-{platform}-{arch}.tar.gz
 */
import { resolve } from "node:path";
import { cp, rm } from "node:fs/promises";

const root = resolve(import.meta.dir, "..");
const pkg = await Bun.file(resolve(root, "package.json")).json();
const version: string = pkg.version;
const platform = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
const arch = process.arch === "arm64" ? "arm64" : "x64";
const archiveName = `flmux-${version}-${platform}-${arch}.tar.gz`;

// Step 1: Build
console.log(`Building flmux v${version} (${platform}-${arch})...`);
const electrobun = resolve(root, "node_modules/.bin/electrobun");
const build = Bun.spawnSync([electrobun, "build"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (build.exitCode !== 0) {
  console.error("Build failed");
  process.exit(1);
}

// Step 2: Add launcher scripts (Windows only)
const devDir = resolve(root, `build/dev-${platform}-${arch}/flmux-dev`);
if (platform === "win") {
  await Bun.write(resolve(devDir, "flmux.bat"), '@echo off\nstart "" "%~dp0bin\\launcher.exe"\n');
  await Bun.write(resolve(devDir, "flmux.ps1"), 'Start-Process "$PSScriptRoot\\bin\\launcher.exe"\n');
}

// Step 3: Create tar.gz with files at root
const outPath = resolve(root, "build", archiveName);
console.log(`Packaging → build/${archiveName}`);
const tar = Bun.spawnSync(["tar", "-czf", `../../${archiveName}`, "."], {
  cwd: devDir,
  stdout: "inherit",
  stderr: "inherit",
});
if (tar.exitCode !== 0) {
  console.error("tar failed");
  process.exit(1);
}

const stat = Bun.file(outPath);
console.log(`Done: build/${archiveName} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
