import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { FLMUX_EXTENSION_API_VERSION } from "@flmux/extension-api";
import type { FlmuxLocalExtensionLoadEntry } from "../src/shared/rendererBridge";
import {
  createLocalExtensionLoadEntries,
  discoverConfiguredLocalExtensions,
  discoverLocalExtensions,
  type LocalExtensionCatalogConfig,
  type DiscoveredLocalExtension
} from "../src/main/localExtensions";
import { createExtensionPaneSpecs } from "../src/main/paneSpecs";
import { startFlmuxServer } from "../src/main/server";
import {
  loadLocalExtensionDefinitions,
  registerLocalExternalPaneDescriptors
} from "../src/renderer/external/registerLocalExternalPaneDescriptors";

const tempDirs: string[] = [];

function pickStableFields(extension: DiscoveredLocalExtension) {
  return {
    id: extension.id,
    name: extension.name,
    version: extension.version,
    runtimeManifest: extension.runtimeManifest,
    rendererEntryRelativePath: extension.rendererEntryRelativePath,
    cliEntryRelativePath: extension.cliEntryRelativePath,
    serverEntryRelativePath: extension.serverEntryRelativePath,
    origin: extension.origin,
    originPath: extension.originPath
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    })
  );
});

describe("local extension loading", () => {
  it("discovers built local extensions and produces explicit same-origin load entries", async () => {
    const extensionsRootDir = await createTempExtensionRoot("catalog");
    await writeExtensionFixture(extensionsRootDir, {
      id: "sample.cowsay",
      name: "Cowsay",
      version: "0.1.0"
    });

    const discovered = await discoverLocalExtensions(extensionsRootDir);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      id: "sample.cowsay",
      name: "Cowsay",
      version: "0.1.0",
      runtimeManifest: {
        apiVersion: FLMUX_EXTENSION_API_VERSION,
        entrypoints: {
          renderer: "index.js"
        }
      }
    });

    const loadEntries = createLocalExtensionLoadEntries(discovered, "http://127.0.0.1:4321", { cacheKey: null });
    expect(loadEntries).toEqual([
      {
        id: "sample.cowsay",
        name: "Cowsay",
        version: "0.1.0",
        manifestUrl: "http://127.0.0.1:4321/__flmux/ext/sample.cowsay/0.1.0/manifest.json",
        rendererEntryUrl: "http://127.0.0.1:4321/__flmux/ext/sample.cowsay/0.1.0/index.js",
        paneIcons: {},
        paneDefaultTitles: {},
        paneMinimumWidths: {},
        paneMaximumWidths: {}
      }
    ]);

    const loadEntriesCached = createLocalExtensionLoadEntries(discovered, "http://127.0.0.1:4321", {
      cacheKey: "abc123"
    });
    expect(loadEntriesCached[0]?.rendererEntryUrl).toBe(
      "http://127.0.0.1:4321/__flmux/ext/sample.cowsay/0.1.0/index.js?v=abc123"
    );
  });

  it("ignores duplicate local extension id/version pairs", async () => {
    const extensionsRootDir = await createTempExtensionRoot("dedupe");
    await writeExtensionFixture(extensionsRootDir, {
      dirName: "cowsay-a",
      id: "sample.cowsay",
      name: "Cowsay A",
      version: "0.1.0"
    });
    await writeExtensionFixture(extensionsRootDir, {
      dirName: "cowsay-b",
      id: "sample.cowsay",
      name: "Cowsay B",
      version: "0.1.0"
    });

    const discovered = await discoverLocalExtensions(extensionsRootDir);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      id: "sample.cowsay",
      version: "0.1.0"
    });
  });

  it("rejects local extensions with unsupported built apiVersion", async () => {
    const extensionsRootDir = await createTempExtensionRoot("api-version");
    await writeExtensionFixture(extensionsRootDir, {
      id: "sample.cowsay",
      name: "Cowsay",
      version: "0.1.0",
      runtimeApiVersion: 99
    });

    const discovered = await discoverLocalExtensions(extensionsRootDir);
    expect(discovered).toEqual([]);
  });

  it("resolves renderer entrypoints from the built manifest", async () => {
    const extensionsRootDir = await createTempExtensionRoot("custom-entry");
    await writeExtensionFixture(extensionsRootDir, {
      id: "sample.cowsay",
      name: "Cowsay",
      version: "0.1.0",
      sourceRendererEntry: "./src/renderer-entry.ts",
      runtimeRendererEntry: "src/renderer-entry.js"
    });

    const discovered = await discoverLocalExtensions(extensionsRootDir);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.rendererEntryRelativePath).toBe("src/renderer-entry.js");
  });

  it("passes through local discovery unchanged when catalog.json is absent", async () => {
    const extensionsRootDir = await createTempExtensionRoot("catalog-absent");
    await writeExtensionFixture(extensionsRootDir, {
      id: "sample.cowsay",
      name: "Cowsay",
      version: "0.1.0"
    });

    const configured = await discoverConfiguredLocalExtensions(extensionsRootDir);
    const raw = await discoverLocalExtensions(extensionsRootDir);
    // Each discovery call returns fresh closure references for resolveRuntimeFile /
    // resolveEntryImportUrl, so compare the serializable fields instead of the whole object.
    expect(configured.map(pickStableFields)).toEqual(raw.map(pickStableFields));
  });

  it("applies catalog additionalRoots and enable/disable selectors", async () => {
    const extensionsRootDir = await createTempExtensionRoot("catalog-policy");
    const extraRootDir = await createTempExtensionRoot("catalog-extra");
    await writeExtensionFixture(extensionsRootDir, {
      id: "sample.cowsay",
      name: "Cowsay",
      version: "0.1.0"
    });
    await writeExtensionFixture(extraRootDir, {
      id: "sample.inspector",
      name: "Inspector",
      version: "0.1.0"
    });
    await writeExtensionFixture(extraRootDir, {
      id: "sample.scratchpad",
      name: "Scratchpad",
      version: "0.2.0"
    });
    await writeCatalogConfig(extensionsRootDir, {
      additionalRoots: [extraRootDir],
      enabled: ["sample.cowsay", "sample.scratchpad@0.2.0"],
      disabled: ["sample.inspector"]
    });

    const discovered = await discoverConfiguredLocalExtensions(extensionsRootDir);
    expect(discovered.map((extension) => `${extension.id}@${extension.version}`)).toEqual([
      "sample.cowsay@0.1.0",
      "sample.scratchpad@0.2.0"
    ]);
  });

  it("lets disabled selectors win over enabled selectors", async () => {
    const extensionsRootDir = await createTempExtensionRoot("catalog-precedence");
    await writeExtensionFixture(extensionsRootDir, {
      id: "sample.cowsay",
      name: "Cowsay",
      version: "0.1.0"
    });
    await writeCatalogConfig(extensionsRootDir, {
      enabled: ["sample.cowsay"],
      disabled: ["sample.cowsay"]
    });

    expect(await discoverConfiguredLocalExtensions(extensionsRootDir)).toEqual([]);
  });

  it("preserves pathMount hooks when loading a packed archive-backed extension", async () => {
    // Reproduces the main-side import regression: after packing an extension
    // into a .tar.gz and loading it through the archive backend, the
    // pathMount / lifecycle hooks on renderer-exported panes must still be
    // available. This exercises `createExtensionPaneSpecs`, which `import()`s
    // the renderer bundle from main to extract those hooks. Uses scratchpad
    // since it's a first-party extension with a pathMount declared.
    const scratchpadDistDir = resolve(__dirname, "../../../extensions/scratchpad/dist");
    const manifest = await readFile(join(scratchpadDistDir, "manifest.json"), "utf8");
    expect(JSON.parse(manifest).id).toBe("sample.scratchpad");

    const catalogRootDir = await createTempExtensionRoot("archive-pathmount");
    const tarballPath = join(catalogRootDir, "scratchpad.tar.gz");

    // Build the archive entries directly from the already-built scratchpad dist/ —
    // mirrors what `flmux-ext pack` produces (flat paths rooted at dist/).
    const entries: Record<string, Uint8Array> = {};
    await collectFiles(scratchpadDistDir, scratchpadDistDir, entries);
    await Bun.Archive.write(tarballPath, entries, { compress: "gzip" });

    await writeFile(join(catalogRootDir, "catalog.json"), JSON.stringify({ tarballs: [tarballPath] }, null, 2), "utf8");

    const discovered = await discoverConfiguredLocalExtensions(catalogRootDir);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.origin).toBe("archive");
    expect(discovered[0]?.id).toBe("sample.scratchpad");

    const specs = await createExtensionPaneSpecs(discovered);
    const scratchpadSpec = specs.find((spec) => spec.kind === "scratchpad");
    expect(scratchpadSpec).toBeDefined();
    // Before the fix: data-URL `import()` can't resolve `@flmux/extension-api`
    // bare specifier, hooks fall back to manifest-only, pathMount === undefined.
    expect(scratchpadSpec?.pathMount?.mountKey).toBe("scratchpad");
  });

  it("serves built local extension manifest and runtime file tree from same-origin routes", async () => {
    const extensionsRootDir = await createTempExtensionRoot("server");
    await writeExtensionFixture(extensionsRootDir, {
      id: "sample.cowsay",
      name: "Cowsay",
      version: "0.1.0",
      sourceRendererEntry: "./index.ts",
      runtimeRendererEntry: "index.js",
      helperSourceModule: "./lib/helper.ts",
      helperRuntimeModule: "./lib/helper.js",
      helperValue: "sample.helper",
      assetSourcePath: "./template.html",
      assetRuntimePath: "./template.html",
      assetContents: "<section>template asset</section>"
    });
    const rendererDir = await createTempRendererDir();
    const localExtensions = await discoverLocalExtensions(extensionsRootDir);
    const loadEntry = createLocalExtensionLoadEntries(localExtensions, "http://127.0.0.1:0")[0];

    const server = startFlmuxServer({
      rendererDir,
      localExtensions,
      resolveShellModelRouter: async () => createShellModelRouterStub()
    });

    try {
      const [manifestResponse, rendererResponse, helperResponse, assetResponse] = await Promise.all([
        fetch(loadEntry.manifestUrl.replace("http://127.0.0.1:0", server.origin)),
        fetch(loadEntry.rendererEntryUrl.replace("http://127.0.0.1:0", server.origin)),
        fetch(`${server.origin}/__flmux/ext/sample.cowsay/0.1.0/lib/helper.js`),
        fetch(`${server.origin}/__flmux/ext/sample.cowsay/0.1.0/template.html`)
      ]);

      expect(manifestResponse.status).toBe(200);
      expect(await manifestResponse.json()).toEqual({
        id: "sample.cowsay",
        name: "Cowsay",
        version: "0.1.0",
        apiVersion: FLMUX_EXTENSION_API_VERSION,
        entrypoints: {
          renderer: "index.js"
        }
      });

      expect(rendererResponse.status).toBe(200);
      const rendererModule = await rendererResponse.text();
      // Fixture uses a bare specifier — real builds inline `@flmux/extension-api`,
      // but the server just passes bytes through for the `.js` route.
      expect(rendererModule).toContain('from "@flmux/extension-api"');
      expect(rendererModule).toContain('from "./lib/helper.js"');

      expect(helperResponse.status).toBe(200);
      expect(await helperResponse.text()).toContain('export const paneKind = "sample.helper"');

      expect(assetResponse.status).toBe(200);
      expect(await assetResponse.text()).toBe("<section>template asset</section>");
    } finally {
      server.stop();
    }
  });

  it("serves the built-in start page with the requested workspace label", async () => {
    const rendererDir = await createTempRendererDir();
    const server = startFlmuxServer({
      rendererDir,
      resolveShellModelRouter: async () => createShellModelRouterStub()
    });

    try {
      const response = await fetch(`${server.origin}/__flmux/internal/start?workspace=workspace.alpha`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("<title>flmux Start</title>");
      expect(html).toContain("Built-in Start Page");
      expect(html).toContain("workspace.alpha");

      const missingFixture = await fetch(`${server.origin}/fixtures/counter`);
      expect(missingFixture.status).toBe(404);
    } finally {
      server.stop();
    }
  });

  it("serves built dist renderer modules without server-side rewrite", async () => {
    const extensionsRootDir = await createTempExtensionRoot("built-static");
    const fixture = await writeExtensionFixture(extensionsRootDir, {
      id: "sample.cowsay",
      name: "Cowsay",
      version: "0.1.0",
      sourceRendererEntry: "./src/index.ts",
      runtimeRendererEntry: "src/index.js"
    });
    const builtCode = 'export { defineExtension } from "@flmux/extension-api";\n';
    await writeFile(join(fixture.extensionDir, "dist", "src", "index.js"), builtCode, "utf8");

    const rendererDir = await createTempRendererDir();
    const localExtensions = await discoverLocalExtensions(extensionsRootDir);
    const loadEntry = createLocalExtensionLoadEntries(localExtensions, "http://127.0.0.1:0")[0];
    const server = startFlmuxServer({
      rendererDir,
      localExtensions,
      resolveShellModelRouter: async () => createShellModelRouterStub()
    });

    try {
      const response = await fetch(loadEntry.rendererEntryUrl.replace("http://127.0.0.1:0", server.origin));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(builtCode);
    } finally {
      server.stop();
    }
  });

  it("skips local extensions that do not have built dist manifests", async () => {
    const extensionsRootDir = await createTempExtensionRoot("missing-dist");
    const fixture = await writeExtensionFixture(extensionsRootDir, {
      id: "sample.cowsay",
      name: "Cowsay",
      version: "0.1.0"
    });
    await rm(join(fixture.extensionDir, "dist"), { recursive: true, force: true });

    const localExtensions = await discoverLocalExtensions(extensionsRootDir);
    expect(localExtensions).toEqual([]);
  });

  it("returns 404 when a built renderer entry disappears before request time", async () => {
    const extensionsRootDir = await createTempExtensionRoot("server-missing-entry");
    const fixture = await writeExtensionFixture(extensionsRootDir, {
      id: "sample.cowsay",
      name: "Cowsay",
      version: "0.1.0"
    });
    const rendererDir = await createTempRendererDir();
    const localExtensions = await discoverLocalExtensions(extensionsRootDir);
    const loadEntry = createLocalExtensionLoadEntries(localExtensions, "http://127.0.0.1:0")[0];
    await unlink(fixture.runtimeRendererEntryPath);

    const server = startFlmuxServer({
      rendererDir,
      localExtensions,
      resolveShellModelRouter: async () => createShellModelRouterStub()
    });

    try {
      const response = await fetch(loadEntry.rendererEntryUrl.replace("http://127.0.0.1:0", server.origin));
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not Found");
    } finally {
      server.stop();
    }
  });

  it("loads explicit renderer entry urls and registers their pane descriptors", async () => {
    const host = {
      descriptors: [] as Array<{ kind: string }>,
      registerExternalPane(descriptor: { kind: string }) {
        this.descriptors.push(descriptor);
      }
    };
    const loadEntries: FlmuxLocalExtensionLoadEntry[] = [
      {
        id: "sample.cowsay",
        name: "Cowsay",
        version: "0.1.0",
        manifestUrl: "http://127.0.0.1:4321/__flmux/ext/sample.cowsay/0.1.0/manifest.json",
        rendererEntryUrl: "http://127.0.0.1:4321/__flmux/ext/sample.cowsay/0.1.0/index.js",
        paneIcons: {},
        paneDefaultTitles: {},
        paneMinimumWidths: {},
        paneMaximumWidths: {}
      },
      {
        id: "sample.inspector",
        name: "Inspector",
        version: "0.1.0",
        manifestUrl: "http://127.0.0.1:4321/__flmux/ext/sample.inspector/0.1.0/manifest.json",
        rendererEntryUrl: "http://127.0.0.1:4321/__flmux/ext/sample.inspector/0.1.0/index.js",
        paneIcons: {},
        paneDefaultTitles: {},
        paneMinimumWidths: {},
        paneMaximumWidths: {}
      }
    ];

    const discovered = await loadLocalExtensionDefinitions(loadEntries, async (entryUrl) => ({
      default: {
        panes: [
          {
            kind: entryUrl.includes("cowsay") ? "cowsay" : "inspector",
            mount() {}
          }
        ]
      }
    }));
    expect(discovered.map((entry) => entry.loadEntry.id)).toEqual(["sample.cowsay", "sample.inspector"]);

    await registerLocalExternalPaneDescriptors(host, loadEntries, async (entryUrl) => ({
      default: {
        panes: [
          {
            kind: entryUrl.includes("cowsay") ? "cowsay" : "inspector",
            mount() {}
          }
        ]
      }
    }));

    expect(host.descriptors.map((descriptor) => descriptor.kind)).toEqual(["cowsay", "inspector"]);
  });
});

async function collectFiles(dir: string, rootDir: string, entries: Record<string, Uint8Array>) {
  const dirEntries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
  for (const entry of dirEntries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(entryPath, rootDir, entries);
      continue;
    }
    const key = relative(rootDir, entryPath).replace(/\\/g, "/");
    entries[key] = new Uint8Array(await Bun.file(entryPath).arrayBuffer());
  }
}

async function createTempExtensionRoot(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), `flmux-ext-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

async function writeCatalogConfig(rootDir: string, config: LocalExtensionCatalogConfig) {
  await writeFile(join(rootDir, "catalog.json"), JSON.stringify(config, null, 2), "utf8");
}

async function createTempRendererDir() {
  const dir = await mkdtemp(join(tmpdir(), "flmux-renderer-"));
  tempDirs.push(dir);
  await writeFile(join(dir, "index.html"), "<!doctype html><title>renderer</title>", "utf8");
  return dir;
}

async function writeExtensionFixture(
  rootDir: string,
  manifest: Pick<DiscoveredLocalExtension, "id" | "name" | "version"> & {
    dirName?: string;
    apiVersion?: number;
    runtimeApiVersion?: number;
    sourceRendererEntry?: string;
    runtimeRendererEntry?: string;
    helperSourceModule?: string;
    helperRuntimeModule?: string;
    helperValue?: string;
    assetSourcePath?: string;
    assetRuntimePath?: string;
    assetContents?: string;
  }
) {
  const extensionDir = join(rootDir, manifest.dirName ?? manifest.id.split(".").pop() ?? "extension");
  const sourceRendererEntry = manifest.sourceRendererEntry ?? "./index.ts";
  const runtimeRendererEntry = manifest.runtimeRendererEntry ?? "index.js";
  const sourceRendererEntryPath = join(extensionDir, sourceRendererEntry);
  const runtimeRendererEntryPath = join(extensionDir, "dist", runtimeRendererEntry);

  await mkdir(extensionDir, { recursive: true });
  await mkdir(dirname(sourceRendererEntryPath), { recursive: true });
  await mkdir(dirname(runtimeRendererEntryPath), { recursive: true });

  await writeFile(
    join(extensionDir, "manifest.json"),
    JSON.stringify(
      {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        apiVersion: manifest.apiVersion ?? FLMUX_EXTENSION_API_VERSION,
        entrypoints: {
          renderer: sourceRendererEntry
        }
      },
      null,
      2
    ),
    "utf8"
  );

  await writeFile(
    join(extensionDir, "dist", "manifest.json"),
    JSON.stringify(
      {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        apiVersion: manifest.runtimeApiVersion ?? manifest.apiVersion ?? FLMUX_EXTENSION_API_VERSION,
        entrypoints: {
          renderer: runtimeRendererEntry
        }
      },
      null,
      2
    ),
    "utf8"
  );

  if (manifest.helperSourceModule && manifest.helperRuntimeModule) {
    const sourceHelperPath = join(extensionDir, manifest.helperSourceModule);
    const runtimeHelperPath = join(extensionDir, "dist", manifest.helperRuntimeModule);
    await mkdir(dirname(sourceHelperPath), { recursive: true });
    await mkdir(dirname(runtimeHelperPath), { recursive: true });
    const helperContents = `export const paneKind = ${JSON.stringify(manifest.helperValue ?? manifest.id)};\n`;
    await writeFile(sourceHelperPath, helperContents, "utf8");
    await writeFile(runtimeHelperPath, helperContents, "utf8");
  }

  if (manifest.assetSourcePath && manifest.assetRuntimePath) {
    const sourceAssetPath = join(extensionDir, manifest.assetSourcePath);
    const runtimeAssetPath = join(extensionDir, "dist", manifest.assetRuntimePath);
    await mkdir(dirname(sourceAssetPath), { recursive: true });
    await mkdir(dirname(runtimeAssetPath), { recursive: true });
    await writeFile(sourceAssetPath, manifest.assetContents ?? "", "utf8");
    await writeFile(runtimeAssetPath, manifest.assetContents ?? "", "utf8");
  }

  await writeFile(
    sourceRendererEntryPath,
    buildRendererEntrySource({
      id: manifest.id,
      helperModule: manifest.helperSourceModule,
      assetPath: manifest.assetSourcePath
    }),
    "utf8"
  );
  await writeFile(
    runtimeRendererEntryPath,
    buildRendererEntrySource({
      id: manifest.id,
      helperModule: manifest.helperRuntimeModule,
      assetPath: manifest.assetRuntimePath
    }),
    "utf8"
  );

  return {
    extensionDir,
    sourceRendererEntryPath,
    runtimeRendererEntryPath
  };
}

function buildRendererEntrySource(options: { id: string; helperModule?: string; assetPath?: string }) {
  const lines = ['import { defineExtension, definePane } from "@flmux/extension-api";'];
  if (options.helperModule) {
    lines.push(`import { paneKind } from ${JSON.stringify(options.helperModule)};`);
  }
  if (options.assetPath) {
    lines.push(`export const assetUrl = new URL(${JSON.stringify(options.assetPath)}, import.meta.url).href;`);
  }
  lines.push(
    "",
    "export default defineExtension({",
    "  panes: [",
    "    definePane({",
    `      kind: ${options.helperModule ? "paneKind" : JSON.stringify(options.id)},`,
    "      mount() {}",
    "    })",
    "  ]",
    "});",
    ""
  );
  return lines.join("\n");
}

function createShellModelRouterStub() {
  return {
    registerClient() {
      return { clientId: "client_test" };
    },
    async listClients() {
      return [];
    },
    async pathGet() {
      throw new Error("not used in local extension route test");
    },
    async pathList() {
      throw new Error("not used in local extension route test");
    },
    async pathSet() {
      throw new Error("not used in local extension route test");
    },
    async pathCall() {
      throw new Error("not used in local extension route test");
    }
  };
}
