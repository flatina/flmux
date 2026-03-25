import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { buildExtensionRegistry, discoverExtensions, loadExtensionAssetText, loadExtensionSource } from "./extension-discovery";

const testRoot = join(tmpdir(), `flmux-ext-test-${Date.now()}`);
const extDir = join(testRoot, "ext");

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
      rendererEntry: "./index.js",
      contributions: {
        panels: [{ id: "cowsay", kind: "panel", title: "Cowsay" }],
        events: [{ id: "moo", description: "Cow says moo" }]
      }
    })
  );
  writeFileSync(
    join(extDir, "sample.cowsay", "index.js"),
    'export function mount(host) { host.textContent = "moo"; }'
  );
  writeFileSync(join(extDir, "sample.cowsay", "index.html"), "<div>moo</div>");

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
    expect(extensions[0].manifest.id).toBe("sample.cowsay");
    expect(extensions[0].embedded).toBe(true);
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

describe("buildExtensionRegistry", () => {
  test("builds registry entries from discovered extensions", () => {
    const extensions = discoverExtensions(testRoot);
    const registry = buildExtensionRegistry(extensions);
    expect(registry).toHaveLength(1);
    expect(registry[0].id).toBe("sample.cowsay");
    expect(registry[0].embedded).toBe(true);
    expect(registry[0].contributions.panels).toHaveLength(1);
    expect(registry[0].contributions.events).toHaveLength(1);
    expect(registry[0].permissions).toEqual([]);
  });
});

describe("loadExtensionSource", () => {
  test("loads extension source", () => {
    const extensions = discoverExtensions(testRoot);
    const result = loadExtensionSource(extensions, "sample.cowsay");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toContain("mount");
    }
  });

  test("returns error for unknown extension", () => {
    const extensions = discoverExtensions(testRoot);
    const result = loadExtensionSource(extensions, "unknown");
    expect(result.ok).toBe(false);
  });

  test("rejects path traversal in rendererEntry", () => {
    const extensions = discoverExtensions(testRoot);
    // Manually tamper with the entry for testing
    const ext = { ...extensions[0], manifest: { ...extensions[0].manifest, rendererEntry: "../../../etc/passwd" } };
    const result = loadExtensionSource([ext], "sample.cowsay");
    expect(result.ok).toBe(false);
  });
});

describe("loadExtensionAssetText", () => {
  test("loads extension text asset", () => {
    const extensions = discoverExtensions(testRoot);
    const result = loadExtensionAssetText(extensions, "sample.cowsay", "./index.html");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toContain("moo");
    }
  });

  test("returns error for unknown extension", () => {
    const extensions = discoverExtensions(testRoot);
    const result = loadExtensionAssetText(extensions, "unknown", "./index.html");
    expect(result.ok).toBe(false);
  });

  test("rejects path traversal", () => {
    const extensions = discoverExtensions(testRoot);
    const result = loadExtensionAssetText(extensions, "sample.cowsay", "../../../etc/passwd");
    expect(result.ok).toBe(false);
  });
});
