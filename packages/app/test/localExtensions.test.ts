import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FlmuxLocalExtensionLoadEntry } from "../src/shared/rendererBridge";
import {
  createLocalExtensionLoadEntries,
  discoverLocalExtensions,
  type DiscoveredLocalExtension
} from "../src/main/localExtensions";
import { startFlmuxServer } from "../src/main/server";
import {
  loadLocalExtensionDefinitions,
  registerLocalExternalPaneDescriptors
} from "../src/renderer/external/registerLocalExternalPaneDescriptors";

const tempDirs: string[] = [];

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
        apiVersion: 1,
        entrypoints: {
          renderer: "index.js"
        }
      }
    });

    const loadEntries = createLocalExtensionLoadEntries(discovered, "http://127.0.0.1:4321");
    expect(loadEntries).toEqual([
      {
        id: "sample.cowsay",
        name: "Cowsay",
        version: "0.1.0",
        manifestUrl: "http://127.0.0.1:4321/__flmux/ext/sample.cowsay/0.1.0/manifest.json",
        rendererEntryUrl: "http://127.0.0.1:4321/__flmux/ext/sample.cowsay/0.1.0/index.js"
      }
    ]);
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
    expect(discovered[0]?.rendererEntryPath).not.toBeNull();
    expect(discovered[0]!.rendererEntryPath!.replace(/\\/g, "/")).toEndWith("/dist/src/renderer-entry.js");
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
      shellModelRouter: createShellModelRouterStub()
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
        apiVersion: 1,
        entrypoints: {
          renderer: "index.js"
        }
      });

      expect(rendererResponse.status).toBe(200);
      const rendererModule = await rendererResponse.text();
      expect(rendererModule).toContain('from "/__flmux/runtime/extension-api.js"');
      expect(rendererModule).toContain('from "./lib/helper.js"');

      expect(helperResponse.status).toBe(200);
      expect(await helperResponse.text()).toContain('export const paneKind = "sample.helper"');

      expect(assetResponse.status).toBe(200);
      expect(await assetResponse.text()).toBe("<section>template asset</section>");
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
    const builtCode = 'export { defineExtension } from "/__flmux/runtime/extension-api.js";\n';
    await writeFile(join(fixture.extensionDir, "dist", "src", "index.js"), builtCode, "utf8");

    const rendererDir = await createTempRendererDir();
    const localExtensions = await discoverLocalExtensions(extensionsRootDir);
    const loadEntry = createLocalExtensionLoadEntries(localExtensions, "http://127.0.0.1:0")[0];
    const server = startFlmuxServer({
      rendererDir,
      localExtensions,
      shellModelRouter: createShellModelRouterStub()
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
      shellModelRouter: createShellModelRouterStub()
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
        rendererEntryUrl: "http://127.0.0.1:4321/__flmux/ext/sample.cowsay/0.1.0/index.js"
      },
      {
        id: "sample.inspector",
        name: "Inspector",
        version: "0.1.0",
        manifestUrl: "http://127.0.0.1:4321/__flmux/ext/sample.inspector/0.1.0/manifest.json",
        rendererEntryUrl: "http://127.0.0.1:4321/__flmux/ext/sample.inspector/0.1.0/index.js"
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

async function createTempExtensionRoot(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), `flmux-ext-${prefix}-`));
  tempDirs.push(dir);
  return dir;
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
    JSON.stringify({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      apiVersion: manifest.apiVersion ?? 1,
      entrypoints: {
        renderer: sourceRendererEntry
      }
    }, null, 2),
    "utf8"
  );

  await writeFile(
    join(extensionDir, "dist", "manifest.json"),
    JSON.stringify({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      apiVersion: manifest.runtimeApiVersion ?? manifest.apiVersion ?? 1,
      entrypoints: {
        renderer: runtimeRendererEntry
      }
    }, null, 2),
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

  await writeFile(sourceRendererEntryPath, buildRendererEntrySource({
    id: manifest.id,
    helperModule: manifest.helperSourceModule,
    assetPath: manifest.assetSourcePath,
    runtimeImport: false
  }), "utf8");
  await writeFile(runtimeRendererEntryPath, buildRendererEntrySource({
    id: manifest.id,
    helperModule: manifest.helperRuntimeModule,
    assetPath: manifest.assetRuntimePath,
    runtimeImport: true
  }), "utf8");

  return {
    extensionDir,
    sourceRendererEntryPath,
    runtimeRendererEntryPath
  };
}

function buildRendererEntrySource(options: {
  id: string;
  helperModule?: string;
  assetPath?: string;
  runtimeImport: boolean;
}) {
  const lines = [
    options.runtimeImport
      ? 'import { defineExtension, definePane } from "/__flmux/runtime/extension-api.js";'
      : 'import { defineExtension, definePane } from "@flmux/extension-api";'
  ];
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
