import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  defaultExtensionsRootDir,
  dispatchLocalCliExtensionCommand,
  discoverLocalCliCommands
} from "../src/cliExtensions";
import { FLMUX_EXTENSION_API_VERSION } from "@flmux/extension-api";

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.FLMUX_EXTENSIONS_ROOT;
  await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

describe("cli extension dispatch", () => {
  it("discovers command metadata from local extension manifests with cli entrypoints", async () => {
    const rootDir = await createCliExtensionFixture();
    const commands = await discoverLocalCliCommands(rootDir);

    expect(commands).toEqual([
      {
        commandId: "cowsay",
        description: "Open a cowsay pane",
        extensionId: "sample.cowsay",
        cliEntryPath: join(rootDir, "cowsay", "dist", "cli.js")
      }
    ]);
  });

  it("dispatches a local extension command and passes shell client context", async () => {
    const rootDir = await createCliExtensionFixture();
    const printed: unknown[] = [];
    const shellCalls: Array<{ path: string; args?: Record<string, unknown> }> = [];

    const handled = await dispatchLocalCliExtensionCommand({
      commandId: "cowsay",
      argv: ["hello", "cli"],
      env: {},
      cwd: "C:\\workspace",
      extensionsRootDir: rootDir,
      async getClient() {
        return {
          get: async () => ({ ok: true, found: true, value: null }),
          list: async () => ({ ok: true, found: true, entries: [] }),
          set: async (_path, value) => ({ ok: true, value }),
          call: async (path, args) => {
            shellCalls.push({ path, args });
            return { ok: true, value: { path, args } };
          }
        };
      },
      print(value) {
        printed.push(value);
      },
      printError(message) {
        throw new Error(message);
      }
    });

    expect(handled).toBe(true);
    expect(shellCalls).toEqual([
      {
        path: "/panes/new",
        args: {
          kind: "cowsay",
          place: "right",
          title: "hello cli"
        }
      }
    ]);
    expect(printed).toEqual([
      {
        ok: true,
        value: {
          path: "/panes/new",
          args: {
            kind: "cowsay",
            place: "right",
            title: "hello cli"
          }
        }
      }
    ]);
  });

  it("returns false when no extension command matches", async () => {
    const rootDir = await createCliExtensionFixture();
    const handled = await dispatchLocalCliExtensionCommand({
      commandId: "unknown",
      argv: [],
      env: {},
      cwd: "C:\\workspace",
      extensionsRootDir: rootDir,
      async getClient() {
        throw new Error("should not be called");
      },
      print() {},
      printError() {}
    });

    expect(handled).toBe(false);
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

async function createCliExtensionFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "flmux-cli-ext-"));
  tempDirs.push(rootDir);
  const extensionDir = join(rootDir, "cowsay");
  const sourceCliEntryPath = join(extensionDir, "cli.ts");
  const runtimeCliEntryPath = join(extensionDir, "dist", "cli.js");

  await mkdir(dirname(sourceCliEntryPath), { recursive: true });
  await mkdir(dirname(runtimeCliEntryPath), { recursive: true });
  await writeFile(
    join(extensionDir, "manifest.json"),
    JSON.stringify(
      {
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
        id: "sample.cowsay",
        name: "Cowsay",
        version: "0.1.0",
        apiVersion: FLMUX_EXTENSION_API_VERSION,
        entrypoints: {
          cli: "cli.js"
        },
        commands: [
          {
            id: "cowsay",
            description: "Open a cowsay pane"
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(
    sourceCliEntryPath,
    [
      "export async function run(context) {",
      "  const client = await context.getClient();",
      '  const result = await client.call("/panes/new", {',
      '    kind: "cowsay",',
      '    place: "right",',
      '    ...(context.argv.length > 0 ? { title: context.argv.join(" ") } : {})',
      "  });",
      "  context.print(result);",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    runtimeCliEntryPath,
    [
      "export async function run(context) {",
      "  const client = await context.getClient();",
      '  const result = await client.call("/panes/new", {',
      '    kind: "cowsay",',
      '    place: "right",',
      '    ...(context.argv.length > 0 ? { title: context.argv.join(" ") } : {})',
      "  });",
      "  context.print(result);",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );

  return rootDir;
}
