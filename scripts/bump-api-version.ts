#!/usr/bin/env bun
// Atomically bump FLMUX_EXTENSION_API_VERSION across the host constants and
// every first-party extensions/<name>/manifest.json. External extensions
// (catalog additionalRoots) self-maintain their apiVersion in their own repos.
//
// Usage:  bun scripts/bump-api-version.ts <next-version>
//
// The exact-equality rule on apiVersion (see `internal notes`)
// means every extension must flip in lockstep with the host; the ritual is
// automated here so the principle costs one command instead of N manifest
// edits. Idempotent: re-running with the same target version is a no-op.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(dirname(Bun.main), "..");

const target = Number.parseInt(Bun.argv[2] ?? "", 10);
if (!Number.isFinite(target) || target <= 0) {
  console.error("Usage: bun scripts/bump-api-version.ts <next-version>");
  process.exit(2);
}

const hostConstantFiles = ["packages/extension-api/src/manifest.ts", "packages/extension-devkit/src/manifest.ts"];

let touched = 0;
let skipped = 0;

for (const relative of hostConstantFiles) {
  const absolute = join(repoRoot, relative);
  const content = readFileSync(absolute, "utf8");
  const next = content.replace(/(FLMUX_EXTENSION_API_VERSION\s*=\s*)(\d+)/, (_match, prefix) => `${prefix}${target}`);
  if (next === content) {
    skipped += 1;
    console.log(`  (no change) ${relative}`);
    continue;
  }
  writeFileSync(absolute, next, "utf8");
  touched += 1;
  console.log(`  updated    ${relative}`);
}

const extensionsDir = join(repoRoot, "extensions");
for (const entry of readdirSync(extensionsDir)) {
  const manifestPath = join(extensionsDir, entry, "manifest.json");
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    continue; // Not an extension dir.
  }
  if (!statSync(manifestPath).isFile()) continue;

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed.apiVersion === target) {
    skipped += 1;
    console.log(`  (no change) extensions/${entry}/manifest.json`);
    continue;
  }
  parsed.apiVersion = target;
  writeFileSync(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  touched += 1;
  console.log(`  updated    extensions/${entry}/manifest.json`);
}

console.log(`\nBumped to ${target} (${touched} updated, ${skipped} already current)`);
