#!/usr/bin/env bun
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const action = process.argv[2];
if (action !== "build" && action !== "validate") {
  console.error("usage: bun scripts/dev-extensions.ts <build|validate>");
  process.exit(2);
}

const repoRoot = resolve(import.meta.dir, "..");
const extDir = join(repoRoot, "extensions");

const paths: string[] = [];
for (const entry of readdirSync(extDir, { withFileTypes: true })) {
  if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
  const manifestPath = join(extDir, entry.name, "manifest.json");
  if (!existsSync(manifestPath)) continue;
  let manifest: { devOnly?: unknown };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    continue;
  }
  if (manifest.devOnly === true) {
    paths.push(join(extDir, entry.name));
  }
}

if (paths.length === 0) {
  console.warn(`no devOnly extensions found under ${extDir}`);
  process.exit(0);
}

const proc = spawn("bun", ["run", "--filter", "@flmux/extension-devkit", action, ...paths], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: process.platform === "win32"
});
proc.on("exit", (code) => process.exit(code ?? 0));
