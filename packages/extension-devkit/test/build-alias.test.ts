import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildExtensionDirectory } from "../src/build";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function extDir(manifest: object, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "flmux-ext-alias-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const manifest = (build?: object) => ({
  id: "sample.alias",
  name: "Alias",
  version: "0.1.0",
  apiVersion: 1,
  entrypoints: { server: "./server.ts" },
  ...(build ? { build } : {})
});

describe("build.alias", () => {
  it("strips `build` from the runtime manifest", async () => {
    const dir = extDir(manifest({ alias: { "fake-pkg": "./stub.ts" } }), {
      "server.ts": "export default {};\n",
      "stub.ts": "export const STUB = 1;\n"
    });
    const result = await buildExtensionDirectory(dir);
    expect(result.ok).toBe(true);
    const runtime = JSON.parse(readFileSync(join(result.outDir, "manifest.json"), "utf8"));
    expect(runtime.build).toBeUndefined();
  });

  it("redirects an aliased import to its replacement (onResolve, graph-wide)", async () => {
    // server.ts imports `fake-pkg`, which doesn't exist — only the alias makes the
    // build resolvable, and the stub's content must land in the bundle.
    const dir = extDir(manifest({ alias: { "fake-pkg": "./stub.ts" } }), {
      "server.ts": 'import { STUB_MARKER } from "fake-pkg";\nexport default STUB_MARKER;\n',
      "stub.ts": 'export const STUB_MARKER = "redirected-ok";\n'
    });
    const result = await buildExtensionDirectory(dir);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(result.outDir, "server.js"), "utf8")).toContain("redirected-ok");
  });

  it("redirects to a bare-specifier replacement (node-resolved)", async () => {
    // Dot-less `to` is a bare specifier, resolved from the ext's node_modules.
    const dir = extDir(manifest({ alias: { "original-pkg": "replacement-pkg" } }), {
      "server.ts": 'import { MARKER } from "original-pkg";\nexport default MARKER;\n',
      "node_modules/replacement-pkg/package.json":
        '{ "name": "replacement-pkg", "version": "1.0.0", "main": "index.js" }',
      "node_modules/replacement-pkg/index.js": 'export const MARKER = "bare-redirected-ok";\n'
    });
    const result = await buildExtensionDirectory(dir);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(result.outDir, "server.js"), "utf8")).toContain("bare-redirected-ok");
  });

  it("fails loudly when an alias target is missing", async () => {
    const dir = extDir(manifest({ alias: { "fake-pkg": "./does-not-exist.ts" } }), {
      "server.ts": "export default {};\n"
    });
    const result = await buildExtensionDirectory(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("alias target not found");
  });
});
