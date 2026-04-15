#!/usr/bin/env bun
import { buildExtensionDirectory, formatExtensionBuildResult } from "./build";
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

if (command) {
  printUsage();
  process.exit(1);
}

printUsage();
process.exit(0);

function printUsage() {
  console.log([
    "Usage:",
    "  flmux-ext validate [extension-dir ...]",
    "  flmux-ext build [extension-dir ...]",
    "",
    "Defaults to the current working directory when no path is provided."
  ].join("\n"));
}
