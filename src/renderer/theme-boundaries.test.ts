import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const rendererRoot = import.meta.dir;
const allowedFiles = new Set([join(rendererRoot, "theme.ts")]);
const rawColorPattern = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/;

function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectTsFiles(fullPath));
      continue;
    }
    if (fullPath.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("renderer theme boundaries", () => {
  test("raw colors stay in theme.ts only", () => {
    const offenders = collectTsFiles(rendererRoot)
      .filter((filePath) => !allowedFiles.has(filePath) && !filePath.endsWith(".test.ts"))
      .filter((filePath) => rawColorPattern.test(readFileSync(filePath, "utf-8")))
      .map((filePath) => relative(process.cwd(), filePath).split(sep).join("/"));

    expect(offenders).toEqual([]);
  });
});
