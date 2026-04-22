#!/usr/bin/env bun
import { buildExtensionDirectory, formatExtensionBuildResult } from "./build";
import { formatExtensionPackResult, packExtensionDirectory } from "./pack";
import { formatExtensionValidationResult, resolveValidateTargets, validateExtensionDirectory } from "./validate";

const [, , command, ...args] = process.argv;

if (command === "validate") {
  const targets = resolveValidateTargets(args);
  const results = await Promise.all(targets.map(async (target) => await validateExtensionDirectory(target)));

  for (const result of results) {
    console.log(formatExtensionValidationResult(result));
  }

  process.exit(results.every((result) => result.ok) ? 0 : 1);
}

if (command === "build") {
  const targets = resolveValidateTargets(args);
  const results = await Promise.all(targets.map(async (target) => await buildExtensionDirectory(target)));

  for (const result of results) {
    console.log(formatExtensionBuildResult(result));
  }

  process.exit(results.every((result) => result.ok) ? 0 : 1);
}

if (command === "pack") {
  const { targets, outDir } = parsePackArgs(args);
  const resolvedTargets = resolveValidateTargets(targets);
  const results = await Promise.all(
    resolvedTargets.map(async (target) => await packExtensionDirectory(target, { outDir }))
  );

  for (const result of results) {
    console.log(formatExtensionPackResult(result));
  }

  process.exit(results.every((result) => result.ok) ? 0 : 1);
}

if (command) {
  printUsage();
  process.exit(1);
}

printUsage();
process.exit(0);

function parsePackArgs(rawArgs: string[]): { targets: string[]; outDir: string | undefined } {
  const targets: string[] = [];
  let outDir: string | undefined;

  for (let i = 0; i < rawArgs.length; i++) {
    const token = rawArgs[i];
    if (token === "--out") {
      outDir = rawArgs[i + 1];
      i++;
      continue;
    }
    targets.push(token);
  }

  return { targets, outDir };
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  flmux-ext validate [extension-dir ...]",
      "  flmux-ext build [extension-dir ...]",
      "  flmux-ext pack [--out <dir>] [extension-dir ...]",
      "",
      "Defaults to the current working directory when no path is provided.",
      "pack: requires a prior build; emits '<id>-<version>.tar.gz' in --out (default: parent of extension-dir)."
    ].join("\n")
  );
}
