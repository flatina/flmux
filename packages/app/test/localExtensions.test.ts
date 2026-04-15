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
  it("discovers local extensions and produces explicit same-origin load entries", async () => {
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
      sourceManifest: {
        apiVersion: 1,
        entrypoints: {
          renderer: "./index.ts"
        }
      },
      runtimeManifest: {
        apiVersion: 1,
        entrypoints: {
          renderer: "./index.ts"
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
        rendererEntryUrl: "http://127.0.0.1:4321/__flmux/ext/sample.cowsay/0.1.0/index.ts"
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

  it("rejects local extensions with unsupported apiVersion", async () => {
    const extensionsRootDir = await createTempExtensionRoot("api-version");
    await writeExtensionFixture(extensionsRootDir, {
      id: "sample.cowsay",
      name: "Cowsay",
      version: "0.1.0",
      apiVersion: 99
    });

    const discovered = await discoverLocalExtensions(extensionsRootDir);
    expect(discovered).toEqual([]);
  });

  it("resolves renderer entrypoints from the manifest instead of assuming index.ts", async () => {
    const extensionsRootDir = await createTempExtensionRoot("custom-entry");
    await writeExtensionFixture(extensionsRootDir, {
      id: "sample.cowsay",
      name: "Cowsay",
      version: "0.1.0",
      rendererEntry: "./src/renderer-entry.ts"
    });

    const discovered = await discoverLocalExtensions(extensionsRootDir);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.rendererEntryPath).not.toBeNull();
    expect(discovered[0]!.rendererEntryPath!.replace(/\\/g, "/")).toEndWith("/src/renderer-entry.ts");
  });

  it("prefers dist runtime manifests and built entry files when they exist", async () => {
    const extensionsRootDir = await createTempExtensionRoot("dist-runtime");
    const fixture = await writeExtensionFixture(extensionsRootDir, {
      id: "sample.cowsay",
      name: "Cowsay",
      version: "0.1.0",
      rendererEntry: "./src/index.ts"
    });

    await mkdir(join(fixture.extensionDir, "dist", "src"), { recursive: true });
    await writeFile(
      join(fixture.extensionDir, "dist", "manifest.json"),
      JSON.stringify({
        id: "sample.cowsay",
        name: "Cowsay",
        version: "0.1.0",
        apiVersion: 1,
        entrypoints: {
          renderer: "src/index.js"
        }
      }, null, 2),
      "utf8"
    );
    await writeFile(
      join(fixture.extensionDir, "dist", "src", "index.js"),
      'export { defineExtension } from "/__flmux/runtime/extension-api.js";\n',
      "utf8"
    );

    const discovered = await discoverLocalExtensions(extensionsRootDir);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      runtimeMode: "dist",
      runtimeRootDir: join(fixture.extensionDir, "dist"),
      runtimeManifestPath: join(fixture.extensionDir, "dist", "manifest.json"),
      runtimeManifest: {
        entrypoints: {
          renderer: "src/index.js"
        }
      }
    });
    expect(discovered[0]!.rendererEntryPath!.replace(/\\/g, "/")).toEndWith("/dist/src/index.js");

    const loadEntries = createLocalExtensionLoadEntries(discovered, "http://127.0.0.1:4321");
    expect(loadEntries[0]?.rendererEntryUrl).toBe(
      "http://127.0.0.1:4321/__flmux/ext/sample.cowsay/0.1.0/src/index.js"
    );
  });

  it("serves local extension manifest, runtime module tree, and source fallback renderer entry from same-origin routes", async () => {
    const extensionsRootDir = await createTempExtensionRoot("server");
    await writeExtensionFixture(extensionsRootDir, {
      id: "sample.cowsay",
      name: "Cowsay",
      version: "0.1.0",
      rendererEntry: "./index.ts",
      helperModule: "./lib/helper.ts",
      helperValue: "sample.helper",
      assetPath: "./template.html",
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
      const [manifestResponse, runtimeResponse, runtimeManifestResponse, rendererResponse, helperResponse, assetResponse] = await Promise.all([
        fetch(loadEntry.manifestUrl.replace("http://127.0.0.1:0", server.origin)),
        fetch(`${server.origin}/__flmux/runtime/extension-api.js`),
        fetch(`${server.origin}/__flmux/runtime/extension-api/manifest.js`),
        fetch(loadEntry.rendererEntryUrl.replace("http://127.0.0.1:0", server.origin)),
        fetch(`${server.origin}/__flmux/ext/sample.cowsay/0.1.0/lib/helper.ts`),
        fetch(`${server.origin}/__flmux/ext/sample.cowsay/0.1.0/template.html`)
      ]);

      expect(manifestResponse.status).toBe(200);
      expect(await manifestResponse.json()).toEqual({
        id: "sample.cowsay",
        name: "Cowsay",
        version: "0.1.0",
        apiVersion: 1,
        entrypoints: {
          renderer: "./index.ts"
        }
      });

      expect(runtimeResponse.status).toBe(200);
      const runtimeRootModule = await runtimeResponse.text();
      expect(runtimeRootModule).toContain('export * from "/__flmux/runtime/extension-api/extension.js"');
      expect(runtimeRootModule).toContain('export * from "/__flmux/runtime/extension-api/pane.js"');
      expect(runtimeRootModule).toContain('export * from "/__flmux/runtime/extension-api/manifest.js"');

      expect(runtimeManifestResponse.status).toBe(200);
      const runtimeManifestModule = await runtimeManifestResponse.text();
      expect(runtimeManifestModule).toContain("export const FLMUX_EXTENSION_API_VERSION = 1");
      expect(runtimeManifestModule).toContain("export function validateExtensionManifest");

      expect(rendererResponse.status).toBe(200);
      const rendererModule = await rendererResponse.text();
      expect(rendererModule).toContain('from "/__flmux/runtime/extension-api.js"');
      expect(rendererModule).not.toContain("@flmux/extension-api");
      expect(rendererModule).toContain('from "./lib/helper.ts"');

      expect(helperResponse.status).toBe(200);
      const helperModule = await helperResponse.text();
      expect(helperModule).toContain('export const paneKind = "sample.helper"');

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
      rendererEntry: "./src/index.ts"
    });
    await mkdir(join(fixture.extensionDir, "dist", "src"), { recursive: true });
    await writeFile(
      join(fixture.extensionDir, "dist", "manifest.json"),
      JSON.stringify({
        id: "sample.cowsay",
        name: "Cowsay",
        version: "0.1.0",
        apiVersion: 1,
        entrypoints: {
          renderer: "src/index.js"
        }
      }, null, 2),
      "utf8"
    );
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

  it("returns 404 when a discovered renderer entry disappears before request time", async () => {
    const extensionsRootDir = await createTempExtensionRoot("server-missing-entry");
    const extensionPaths = await writeExtensionFixture(extensionsRootDir, {
      id: "sample.cowsay",
      name: "Cowsay",
      version: "0.1.0"
    });
    const rendererDir = await createTempRendererDir();
    const localExtensions = await discoverLocalExtensions(extensionsRootDir);
    const loadEntry = createLocalExtensionLoadEntries(localExtensions, "http://127.0.0.1:0")[0];
    await unlink(extensionPaths.rendererEntryPath);

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
        rendererEntryUrl: "http://127.0.0.1:4321/__flmux/ext/sample.cowsay/0.1.0/index.ts"
      },
      {
        id: "sample.inspector",
        name: "Inspector",
        version: "0.1.0",
        manifestUrl: "http://127.0.0.1:4321/__flmux/ext/sample.inspector/0.1.0/manifest.json",
        rendererEntryUrl: "http://127.0.0.1:4321/__flmux/ext/sample.inspector/0.1.0/index.ts"
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
    rendererEntry?: string;
    helperModule?: string;
    helperValue?: string;
    assetPath?: string;
    assetContents?: string;
  }
) {
  const extensionDir = join(rootDir, manifest.dirName ?? manifest.id.split(".").pop() ?? "extension");
  const rendererEntry = manifest.rendererEntry ?? "./index.ts";
  const rendererEntryPath = join(extensionDir, rendererEntry);
  await mkdir(extensionDir, { recursive: true });
  await mkdir(dirname(rendererEntryPath), { recursive: true });
  await writeFile(
    join(extensionDir, "manifest.json"),
    JSON.stringify({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      apiVersion: manifest.apiVersion ?? 1,
      entrypoints: {
        renderer: rendererEntry
      },
      commands: undefined
    }, null, 2),
    "utf8"
  );
  if (manifest.helperModule) {
    const helperModulePath = join(extensionDir, manifest.helperModule);
    await mkdir(dirname(helperModulePath), { recursive: true });
    await writeFile(
      helperModulePath,
      `export const paneKind = ${JSON.stringify(manifest.helperValue ?? manifest.id)};\n`,
      "utf8"
    );
  }
  if (manifest.assetPath) {
    const assetPath = join(extensionDir, manifest.assetPath);
    await mkdir(dirname(assetPath), { recursive: true });
    await writeFile(assetPath, manifest.assetContents ?? "", "utf8");
  }
  await writeFile(
    rendererEntryPath,
    buildRendererEntrySource(manifest),
    "utf8"
  );

  return {
    extensionDir,
    manifestPath: join(extensionDir, "manifest.json"),
    rendererEntryPath
  };
}

function buildRendererEntrySource(manifest: {
  id: string;
  helperModule?: string;
  assetPath?: string;
}) {
  const lines = ['import { defineExtension, definePane } from "@flmux/extension-api";'];
  if (manifest.helperModule) {
    lines.push(`import { paneKind } from ${JSON.stringify(manifest.helperModule)};`);
  }
  if (manifest.assetPath) {
    lines.push(`export const assetUrl = new URL(${JSON.stringify(manifest.assetPath)}, import.meta.url).href;`);
  }
  lines.push(
    "",
    "export default defineExtension({",
    "  panes: [",
    "    definePane({",
    `      kind: ${manifest.helperModule ? "paneKind" : JSON.stringify(manifest.id)},`,
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
