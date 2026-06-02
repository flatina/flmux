import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { buildExtensionDirectory } from "../src/build";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function fixture(ignoreText: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "flmux-ext-ignore-"));
  tempDirs.push(dir);
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      id: "sample.ig",
      name: "Ig",
      version: "0.1.0",
      apiVersion: 1,
      entrypoints: { renderer: "./index.ts" },
      panes: [{ kind: "ig", defaultTitle: "Ig" }]
    })
  );
  writeFileSync(join(dir, "index.ts"), "export default {};\n");
  mkdirSync(join(dir, "src", "_wasm"), { recursive: true });
  writeFileSync(join(dir, "src", "keep.txt"), "keep");
  writeFileSync(join(dir, "src", "_wasm", "m.wasm"), "wasm");
  mkdirSync(join(dir, "vendor"), { recursive: true });
  writeFileSync(join(dir, "vendor", "secret.bin"), "secret");
  writeFileSync(join(dir, "notes.md"), "memo");
  if (ignoreText !== null) writeFileSync(join(dir, ".flmux-ext-ignore"), ignoreText);
  return dir;
}

function distRel(result: { outDir: string; builtFiles: string[] }): string[] {
  return result.builtFiles.map((f) => relative(result.outDir, f).replace(/\\/g, "/"));
}

describe("build static-asset ship-exclusion (.flmux-ext-ignore)", () => {
  it("excludes ignored files/dirs and the ignore file itself; keeps the rest", async () => {
    const result = await buildExtensionDirectory(fixture("vendor/\n*.md\n"));
    expect(result.ok).toBe(true);
    const rel = distRel(result);
    expect(rel).toContain("src/keep.txt");
    expect(rel).toContain("src/_wasm/m.wasm");
    expect(rel.some((p) => p.startsWith("vendor/"))).toBe(false);
    expect(rel).not.toContain("notes.md");
    expect(rel).not.toContain(".flmux-ext-ignore");
  });

  it("no ignore file → copies everything (no regression)", async () => {
    const result = await buildExtensionDirectory(fixture(null));
    expect(result.ok).toBe(true);
    const rel = distRel(result);
    expect(rel).toContain("vendor/secret.bin");
    expect(rel).toContain("notes.md");
    expect(rel).toContain("src/keep.txt");
  });
});
