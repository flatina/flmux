#!/usr/bin/env bun
// Pack every extension under `extensions/*` into a gzip tarball, skipping
// example extensions (manifest.id starts with `sample.`). Sample extensions
// double as first-party test fixtures and stay in-tree; the production ship
// layout consumes pack outputs only.
//
// Usage:  bun scripts/pack-extensions.ts [--out <dir>]
//
// Default output: <repoRoot>/dist/extensions/<id>-<version>.tar.gz.
//
// Packs already-built `dist/` trees — run the extension's build first
// (`bun run build:extensions` for first-party; a per-extension workflow for
// anything else). Using the already-built dist keeps this script agnostic to
// how each extension is built (junction layouts, custom bundlers, etc.).

import { readdir, readFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { formatExtensionPackResult, packExtensionDirectory } from "../packages/extension-devkit/src/pack";

const repoRoot = resolve(dirname(Bun.main), "..");
const extensionsRoot = join(repoRoot, "extensions");

const outDirArg = (() => {
  const idx = Bun.argv.indexOf("--out");
  if (idx === -1 || idx === Bun.argv.length - 1) return null;
  return Bun.argv[idx + 1]!;
})();
const outDir = outDirArg ? resolve(outDirArg) : join(repoRoot, "dist", "extensions");

const dirEntries = await readdir(extensionsRoot, { withFileTypes: true });
const candidateDirs = dirEntries
  .filter((e) => e.isDirectory() || e.isSymbolicLink())
  .map((e) => join(extensionsRoot, e.name));

const targets: string[] = [];
for (const dir of candidateDirs) {
  const manifestPath = join(dir, "manifest.json");
  try {
    const raw = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as { id?: unknown };
    if (typeof parsed.id !== "string") {
      console.warn(`  (skip)     ${dir} — manifest missing string 'id'`);
      continue;
    }
    if (parsed.id.startsWith("sample.")) {
      console.log(`  (example)  ${dir} — id '${parsed.id}' starts with 'sample.', skipped`);
      continue;
    }
    targets.push(dir);
  } catch {
    // Not an extension source dir (no manifest), or unreadable.
  }
}

if (targets.length === 0) {
  console.log("\nNo production extensions to pack.");
  process.exit(0);
}

await mkdir(outDir, { recursive: true });

let failures = 0;
for (const dir of targets) {
  const pack = await packExtensionDirectory(dir, { outDir });
  console.log(formatExtensionPackResult(pack));
  if (!pack.ok) failures += 1;
}

console.log(`\nPacked ${targets.length - failures}/${targets.length} → ${outDir}`);
process.exit(failures === 0 ? 0 : 1);
