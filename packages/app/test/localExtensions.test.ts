import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      version: "0.1.0"
    });

    const loadEntries = createLocalExtensionLoadEntries(discovered, "http://127.0.0.1:4321");
    expect(loadEntries).toEqual([
      {
        id: "sample.cowsay",
        name: "Cowsay",
        version: "0.1.0",
        manifestUrl: "http://127.0.0.1:4321/__flmux/ext/sample.cowsay/0.1.0/manifest.json",
        rendererEntryUrl: "http://127.0.0.1:4321/__flmux/ext/sample.cowsay/0.1.0/renderer.js"
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

  it("serves local extension manifest, runtime shim, and transpiled renderer entry from same-origin routes", async () => {
    const extensionsRootDir = await createTempExtensionRoot("server");
    await writeExtensionFixture(extensionsRootDir, {
      id: "sample.cowsay",
      name: "Cowsay",
      version: "0.1.0"
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
      const [manifestResponse, runtimeResponse, rendererResponse] = await Promise.all([
        fetch(loadEntry.manifestUrl.replace("http://127.0.0.1:0", server.origin)),
        fetch(`${server.origin}/__flmux/runtime/extension-api.js`),
        fetch(loadEntry.rendererEntryUrl.replace("http://127.0.0.1:0", server.origin))
      ]);

      expect(manifestResponse.status).toBe(200);
      expect(await manifestResponse.json()).toEqual({
        id: "sample.cowsay",
        name: "Cowsay",
        version: "0.1.0"
      });

      expect(runtimeResponse.status).toBe(200);
      expect(await runtimeResponse.text()).toContain("export function defineExtension");

      expect(rendererResponse.status).toBe(200);
      const rendererModule = await rendererResponse.text();
      expect(rendererModule).toContain('from "/__flmux/runtime/extension-api.js"');
      expect(rendererModule).not.toContain("@flmux/extension-api");
      expect(rendererModule).toContain("defineExtension");
      expect(rendererModule).toContain("definePane");
    } finally {
      server.stop();
    }
  });

  it("returns a generic 500 when a discovered renderer entry disappears before request time", async () => {
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
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Failed to load local extension renderer entry");
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
        rendererEntryUrl: "http://127.0.0.1:4321/__flmux/ext/sample.cowsay/0.1.0/renderer.js"
      },
      {
        id: "sample.inspector",
        name: "Inspector",
        version: "0.1.0",
        manifestUrl: "http://127.0.0.1:4321/__flmux/ext/sample.inspector/0.1.0/manifest.json",
        rendererEntryUrl: "http://127.0.0.1:4321/__flmux/ext/sample.inspector/0.1.0/renderer.js"
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
  manifest: Pick<DiscoveredLocalExtension, "id" | "name" | "version"> & { dirName?: string }
) {
  const extensionDir = join(rootDir, manifest.dirName ?? manifest.id.split(".").pop() ?? "extension");
  await mkdir(extensionDir, { recursive: true });
  await writeFile(
    join(extensionDir, "manifest.json"),
    JSON.stringify({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version
    }, null, 2),
    "utf8"
  );
  await writeFile(
    join(extensionDir, "index.ts"),
    [
      'import { defineExtension, definePane } from "@flmux/extension-api";',
      "",
      "export default defineExtension({",
      "  panes: [",
      "    definePane({",
      `      kind: ${JSON.stringify(manifest.id)},`,
      "      mount() {}",
      "    })",
      "  ]",
      "});",
      ""
    ].join("\n"),
    "utf8"
  );

  return {
    extensionDir,
    manifestPath: join(extensionDir, "manifest.json"),
    rendererEntryPath: join(extensionDir, "index.ts")
  };
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
