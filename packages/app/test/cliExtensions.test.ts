import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultExtensionsRootDir, discoverLocalCliCommands, loadLocalCliCommandDef } from "../src/cliExtensions";
import { FLMUX_EXTENSION_API_VERSION } from "@flmux/extension-api";

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.FLMUX_EXTENSIONS_ROOT;
  await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

describe("cli extension registration", () => {
  it("discovers command metadata from local extension manifests with cli entrypoints", async () => {
    const rootDir = await createCliExtensionFixture();
    const commands = await discoverLocalCliCommands(rootDir);

    expect(commands).toMatchObject([
      {
        commandId: "cowsay",
        description: "Open a cowsay pane",
        extensionId: "sample.cowsay",
        cliEntryRelativePath: "cli.js"
      }
    ]);
    expect(commands[0]?.extension.origin).toBe("source");
  });

  it("loads the extension's default-exported citty CommandDef", async () => {
    const rootDir = await createCliExtensionFixture();
    const [command] = await discoverLocalCliCommands(rootDir);
    const def = await loadLocalCliCommandDef(command!);

    expect(def).toBeTruthy();
    // Citty CommandDefs carry meta + run; this confirms the extension
    // default-exported the shape flmux registers at the root level.
    const rawMeta = def?.meta;
    const meta = typeof rawMeta === "function" ? await rawMeta() : rawMeta;
    expect((meta as { name?: string } | undefined)?.name).toBe("cowsay");
  });

  it("returns null when a loaded module doesn't default-export a CommandDef", async () => {
    const rootDir = await createCliExtensionFixture({ badExport: true });
    const [command] = await discoverLocalCliCommands(rootDir);
    const def = await loadLocalCliCommandDef(command!);
    expect(def).toBeNull();
  });

  it("runs the first-party cowsay CommandDef end-to-end against a stub flmux server", async () => {
    // Drive the real cowsay CLI build through its full path: citty parse →
    // createFlmuxClient → /api/clients lookup → /api/model/path/call. Mounts
    // a stub HTTP server so the test owns the responses and asserts on the
    // outbound request body (what the extension author's `client.call`
    // actually sends over the wire).
    const { resolve } = await import("node:path");
    const cowsayDistDir = resolve(__dirname, "../../../extensions/cowsay/dist");
    const cowsayCliUrl = (await import("node:url")).pathToFileURL(resolve(cowsayDistDir, "cli.js")).href;

    const calls: Array<{ pathname: string; body: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = req.method === "POST" ? await req.json() : null;
        calls.push({ pathname: url.pathname, body });
        if (url.pathname === "/api/clients") {
          return Response.json({ ok: true, clients: [{ clientId: "stub.client" }] });
        }
        if (url.pathname === "/api/model/path/call") {
          return Response.json({ ok: true, result: { ok: true, value: { paneId: "pane.stub" } } });
        }
        return new Response("not found", { status: 404 });
      }
    });

    try {
      const mod = (await import(cowsayCliUrl)) as { default: { run: (ctx: unknown) => Promise<void> } };
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (v: unknown) => {
        logs.push(typeof v === "string" ? v : JSON.stringify(v));
      };
      try {
        await mod.default.run({
          args: {
            _: ["moo moo"],
            origin: `http://127.0.0.1:${server.port}`,
            title: "moo moo"
          },
          rawArgs: []
        });
      } finally {
        console.log = originalLog;
      }

      expect(calls).toEqual([
        { pathname: "/api/clients", body: null },
        {
          pathname: "/api/model/path/call",
          body: {
            clientId: "stub.client",
            path: "/panes/new",
            args: { kind: "cowsay", place: "right", title: "moo moo" }
          }
        }
      ]);
      expect(logs.at(-1)).toContain("pane.stub");
    } finally {
      server.stop(true);
    }
  });

  it("applies catalog disable policy to CLI command discovery", async () => {
    const rootDir = await createCliExtensionFixture();
    await writeFile(
      join(rootDir, "catalog.json"),
      JSON.stringify(
        {
          disabled: ["sample.cowsay"]
        },
        null,
        2
      ),
      "utf8"
    );

    expect(await discoverLocalCliCommands(rootDir)).toEqual([]);
  });

  it("uses FLMUX_EXTENSIONS_ROOT as the default extension root override", () => {
    process.env.FLMUX_EXTENSIONS_ROOT = "  C:\\custom-extensions  ";
    expect(defaultExtensionsRootDir()).toBe("C:\\custom-extensions");
  });
});

async function createCliExtensionFixture(options: { badExport?: boolean } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "flmux-cli-ext-"));
  tempDirs.push(rootDir);
  const extensionDir = join(rootDir, "cowsay");
  const sourceCliEntryPath = join(extensionDir, "cli.ts");
  const runtimeCliEntryPath = join(extensionDir, "dist", "cli.js");

  await mkdir(dirname(sourceCliEntryPath), { recursive: true });
  await mkdir(dirname(runtimeCliEntryPath), { recursive: true });

  const manifest = {
    id: "sample.cowsay",
    name: "Cowsay",
    version: "0.1.0",
    apiVersion: FLMUX_EXTENSION_API_VERSION,
    entrypoints: {
      cli: "./cli.ts"
    },
    commands: [
      {
        id: "cowsay",
        description: "Open a cowsay pane"
      }
    ]
  };
  await writeFile(join(extensionDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  await writeFile(
    join(extensionDir, "dist", "manifest.json"),
    JSON.stringify({ ...manifest, entrypoints: { cli: "cli.js" } }, null, 2),
    "utf8"
  );

  const runtimeContents = options.badExport
    ? "export const notADefault = 1;\n"
    : [
        "export default {",
        '  meta: { name: "cowsay", description: "Open a cowsay pane" },',
        "  async run() {}",
        "};",
        ""
      ].join("\n");

  await writeFile(sourceCliEntryPath, "// source stub for discovery\n", "utf8");
  await writeFile(runtimeCliEntryPath, runtimeContents, "utf8");

  return rootDir;
}
