#!/usr/bin/env bun
import { formatExtensionValidationResult, resolveValidateTargets, validateExtensionDirectory } from "./validate";

const [, , command, ...args] = process.argv;

if (command !== "validate") {
  printUsage();
  process.exit(command ? 1 : 0);
}

const targets = resolveValidateTargets(args);
const results = await Promise.all(targets.map(async (target) => await validateExtensionDirectory(target)));

for (const result of results) {
  console.log(formatExtensionValidationResult(result));
}

process.exit(results.every((result) => result.ok) ? 0 : 1);

function printUsage() {
  console.log([
    "Usage:",
    "  flmux-ext validate [extension-dir ...]",
    "",
    "Defaults to the current working directory when no path is provided."
  ].join("\n"));
}
