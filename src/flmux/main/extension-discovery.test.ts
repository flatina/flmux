import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { buildExtensionSetups, discoverExtensions, loadExtensionText } from "./extension-discovery";

const testRoot = join(tmpdir(), `flmux-ext-test-${Date.now()}`);
const extDir = join(testRoot, "ext");
const bundledRoot = join(testRoot, "Resources", "app");
const bundledExtDir = join(bundledRoot, "ext");

beforeAll(() => {
  // Create embedded extension
  mkdirSync(join(extDir, "sample.cowsay"), { recursive: true });
  writeFileSync(
    join(extDir, "sample.cowsay", "flmux-extension.json"),
    JSON.stringify({
      id: "sample.cowsay",
      name: "Cowsay",
      version: "0.1.0",
      apiVersion: 1,
      rendererEntry: "./index.js"
    })
  );
  writeFileSync(
    join(extDir, "sample.cowsay", "index.js"),
    'export function mount(host) { host.textContent = "moo"; }'
  );
  writeFileSync(join(extDir, "sample.cowsay", "index.html"), "<div>moo</div>");

  mkdirSync(join(bundledExtDir, "sample.bundled"), { recursive: true });
  writeFileSync(
    join(bundledExtDir, "sample.bundled", "flmux-extension.json"),
    JSON.stringify({
      id: "sample.bundled",
      name: "Bundled Sample",
      version: "0.1.0",
      apiVersion: 1,
      rendererEntry: "./index.js"
    })
  );
  writeFileSync(
    join(bundledExtDir, "sample.bundled", "index.js"),
    'export function mount(host) { host.textContent = "bundled"; }'
  );

  // Create invalid extension (no manifest)
  mkdirSync(join(extDir, "invalid"), { recursive: true });

  // Create extension with missing fields
  mkdirSync(join(extDir, "bad-manifest"), { recursive: true });
  writeFileSync(join(extDir, "bad-manifest", "flmux-extension.json"), "{}");
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("discoverExtensions", () => {
  test("discovers embedded extensions", () => {
    const extensions = discoverExtensions(testRoot);
    expect(extensions).toHaveLength(1);
    expect(extensions.find((e) => e.manifest.id === "sample.cowsay")?.embedded).toBe(true);
  });

  test("discovers bundled app extensions from Resources/app", () => {
    const extensions = discoverExtensions(bundledRoot);
    expect(extensions.find((e) => e.manifest.id === "sample.bundled")?.embedded).toBe(true);
  });

  test("skips directories without manifest", () => {
    const extensions = discoverExtensions(testRoot);
    expect(extensions.find((e) => e.manifest.id === "invalid")).toBeUndefined();
  });

  test("skips manifests with missing required fields", () => {
    const extensions = discoverExtensions(testRoot);
    expect(extensions.find((e) => e.manifest.id === "bad-manifest")).toBeUndefined();
  });
});

describe("buildExtensionSetups", () => {
  test("builds setup modules from discovered extensions", async () => {
    const extensions = discoverExtensions(testRoot);
    const setups = await buildExtensionSetups(extensions);
    expect(setups).toHaveLength(1);
    const cowsay = setups.find((entry) => entry.id === "sample.cowsay");
    expect(cowsay).toEqual({
      id: "sample.cowsay",
      source: undefined
    });
  });
});

describe("loadExtensionText renderer", () => {
  test("loads extension source", async () => {
    const extensions = discoverExtensions(testRoot);
    const result = await loadExtensionText(extensions, { extensionId: "sample.cowsay", kind: "renderer" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toContain("mount");
    }
  });

  test("returns error for unknown extension", async () => {
    const extensions = discoverExtensions(testRoot);
    const result = await loadExtensionText(extensions, { extensionId: "unknown", kind: "renderer" });
    expect(result.ok).toBe(false);
  });

  test("rejects path traversal in rendererEntry", async () => {
    const extensions = discoverExtensions(testRoot);
    // Manually tamper with the entry for testing
    const cowsay = extensions.find((entry) => entry.manifest.id === "sample.cowsay");
    expect(cowsay).toBeDefined();
    const ext = { ...cowsay!, manifest: { ...cowsay!.manifest, rendererEntry: "../../../etc/passwd" } };
    const result = await loadExtensionText([ext], { extensionId: "sample.cowsay", kind: "renderer" });
    expect(result.ok).toBe(false);
  });
});

describe("loadExtensionText asset", () => {
  test("loads extension text asset", async () => {
    const extensions = discoverExtensions(testRoot);
    const result = await loadExtensionText(extensions, {
      extensionId: "sample.cowsay",
      kind: "asset",
      path: "./index.html"
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toContain("moo");
    }
  });

  test("returns error for unknown extension", async () => {
    const extensions = discoverExtensions(testRoot);
    const result = await loadExtensionText(extensions, { extensionId: "unknown", kind: "asset", path: "./index.html" });
    expect(result.ok).toBe(false);
  });

  test("rejects path traversal", async () => {
    const extensions = discoverExtensions(testRoot);
    const result = await loadExtensionText(extensions, {
      extensionId: "sample.cowsay",
      kind: "asset",
      path: "../../../etc/passwd"
    });
    expect(result.ok).toBe(false);
  });
});
