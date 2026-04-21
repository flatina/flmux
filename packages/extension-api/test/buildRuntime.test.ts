import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExtensionApiRuntime } from "../src/buildRuntime";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

describe("extension-api runtime build", () => {
  it("builds a static runtime tree with browser-resolvable js specifiers", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "flmux-extension-api-src-"));
    const outDir = await mkdtemp(join(tmpdir(), "flmux-extension-api-out-"));
    tempDirs.push(sourceDir, outDir);

    await writeFile(join(sourceDir, "index.ts"), 'export * from "./manifest";\nexport * from "./extension";\n', "utf8");
    await writeFile(join(sourceDir, "manifest.ts"), "export const version = 1;\n", "utf8");
    await writeFile(
      join(sourceDir, "extension.ts"),
      "export function defineExtension(value) { return value; }\n",
      "utf8"
    );

    const result = await buildExtensionApiRuntime({ sourceDir, outDir });
    expect(result.ok).toBe(true);

    const rootModule = await Bun.file(join(outDir, "index.js")).text();
    expect(rootModule).toContain('export * from "/__flmux/runtime/extension-api/manifest.js"');
    expect(rootModule).toContain('export * from "/__flmux/runtime/extension-api/extension.js"');

    expect(await Bun.file(join(outDir, "manifest.js")).text()).toContain("export const version = 1;");
    expect(await Bun.file(join(outDir, "extension.js")).text()).toContain("export function defineExtension");
  });
});
