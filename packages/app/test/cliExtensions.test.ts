import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  defaultExtensionsRootDir,
  discoverLocalCliCommands,
  invokeInProcessExtensionCli,
  isInProcessCliEntitled,
  loadLocalCliCommandDef,
  loadRawCliCommand,
  type InProcessCliHost
} from "../src/cliExtensions";
import type { DiscoveredLocalExtension } from "../src/main/localExtensions";
import { FLMUX_EXTENSION_API_VERSION } from "@flmux/extension-api";
import type { ShellClient } from "@flmux/extension-api/cli";

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

  it("loads the extension's default-exported defineExtensionCommand and wraps it as a CommandDef", async () => {
    const rootDir = await createCliExtensionFixture();
    const [command] = await discoverLocalCliCommands(rootDir);
    const def = await loadLocalCliCommandDef(command!, {
      resolveExtensionDataDir: () => "C:\\flmux\\.flmux\\ext\\sample.cowsay"
    });

    expect(def).toBeTruthy();
    const rawMeta = def?.meta;
    const meta = typeof rawMeta === "function" ? await rawMeta() : rawMeta;
    expect((meta as { name?: string } | undefined)?.name).toBe("cowsay");
  });

  it("returns null when a loaded module doesn't default-export a FlmuxExtensionCommand", async () => {
    const rootDir = await createCliExtensionFixture({ badExport: true });
    const [command] = await discoverLocalCliCommands(rootDir);
    const def = await loadLocalCliCommandDef(command!, { resolveExtensionDataDir: () => "C:\\unused" });
    expect(def).toBeNull();
  });

  it("injects ctx.dataDir into the extension run() — extension never claims its own id", async () => {
    const rootDir = await createCliExtensionFixture({ recordCtx: true });
    const [command] = await discoverLocalCliCommands(rootDir);
    const def = await loadLocalCliCommandDef(command!, {
      resolveExtensionDataDir: (id) => (id === "sample.cowsay" ? "C:\\flmux\\.flmux\\ext\\sample.cowsay" : null)
    });
    expect(def).toBeTruthy();
    const calls: unknown[] = [];
    (globalThis as unknown as { __flmuxCliCtxRecord?: unknown[] }).__flmuxCliCtxRecord = calls;
    await def?.run?.({ args: { _: [] }, rawArgs: [], cmd: def, data: undefined } as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ dataDir: "C:\\flmux\\.flmux\\ext\\sample.cowsay" });
    expect(typeof (calls[0] as { loadConfig?: unknown }).loadConfig).toBe("function");
  });

  it("propagates ctx.dataDir recursively into nested subCommands", async () => {
    const rootDir = await createCliExtensionFixture({ recordCtxInSub: true });
    const [command] = await discoverLocalCliCommands(rootDir);
    const def = await loadLocalCliCommandDef(command!, {
      resolveExtensionDataDir: (id) => (id === "sample.cowsay" ? "C:\\flmux\\.flmux\\ext\\sample.cowsay" : null)
    });
    expect(def).toBeTruthy();
    const calls: unknown[] = [];
    (globalThis as unknown as { __flmuxCliCtxRecord?: unknown[] }).__flmuxCliCtxRecord = calls;
    type WrappedSub = { run: (input: unknown) => Promise<void>; subCommands?: Record<string, WrappedSub> };
    const subs = def?.subCommands as Record<string, WrappedSub> | undefined;
    const deeper = subs?.nested.subCommands?.deeper;
    expect(deeper).toBeTruthy();
    await deeper?.run({ args: { _: [] }, rawArgs: [], cmd: deeper, data: undefined } as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ dataDir: "C:\\flmux\\.flmux\\ext\\sample.cowsay" });
  });

  it("refuses to run when extId is unknown to the resolver", async () => {
    const rootDir = await createCliExtensionFixture();
    const [command] = await discoverLocalCliCommands(rootDir);
    const def = await loadLocalCliCommandDef(command!, { resolveExtensionDataDir: () => null });
    await expect(def?.run?.({ args: { _: [] }, rawArgs: [], cmd: def, data: undefined } as never)).rejects.toThrow(
      /not registered/
    );
  });

  it("loadRawCliCommand returns the raw command (inProcess preserved), cached by entry url", async () => {
    const rootDir = await createCliExtensionFixture({ inProcess: true });
    const [command] = await discoverLocalCliCommands(rootDir);
    const raw = await loadRawCliCommand(command!.extension);
    expect(raw?.inProcess).toBe(true);
    expect(typeof raw?.run).toBe("function");
    expect(await loadRawCliCommand(command!.extension)).toBe(raw); // cached — same ref
  });

  it("ctx.shell is lazy: a command that never touches it runs without --origin", async () => {
    delete process.env.FLMUX_ORIGIN;
    const rootDir = await createCliExtensionFixture(); // default run() {} — no shell use
    const [command] = await discoverLocalCliCommands(rootDir);
    const def = await loadLocalCliCommandDef(command!, { resolveExtensionDataDir: () => "C:\\x" });
    await expect(
      def?.run?.({ args: { _: [] }, rawArgs: [], cmd: def, data: undefined } as never)
    ).resolves.toBeUndefined();
  });

  it("ctx.shell builds its HTTP client lazily — first use without --origin throws", async () => {
    delete process.env.FLMUX_ORIGIN;
    const rootDir = await createCliExtensionFixture({ usesShell: true });
    const [command] = await discoverLocalCliCommands(rootDir);
    const def = await loadLocalCliCommandDef(command!, { resolveExtensionDataDir: () => "C:\\x" });
    await expect(def?.run?.({ args: { _: [] }, rawArgs: [], cmd: def, data: undefined } as never)).rejects.toThrow(
      /origin/i
    );
  });

  it("renders def.format() to stdout on the subprocess path", async () => {
    const rootDir = await createCliExtensionFixture({
      cliSource: [
        "export default {",
        '  [Symbol.for("flmux.extensionCommand")]: true,',
        '  meta: { name: "cowsay" },',
        '  async run() { return { rows: ["a", "b"] }; },',
        "  format(result) { return result.rows; }",
        "};",
        ""
      ].join("\n")
    });
    const [command] = await discoverLocalCliCommands(rootDir);
    const def = await loadLocalCliCommandDef(command!, { resolveExtensionDataDir: () => "C:\\x" });
    const writes: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((s: string) => {
      writes.push(s);
      return true;
    }) as typeof process.stdout.write;
    try {
      await def?.run?.({ args: { _: [] }, rawArgs: [], cmd: def, data: undefined } as never);
    } finally {
      process.stdout.write = original;
    }
    expect(writes.join("")).toBe("a\nb\n");
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
          return Response.json({ ok: true, clients: [{ authorityClientId: "stub.client" }] });
        }
        if (url.pathname === "/api/model/path/call") {
          return Response.json({ ok: true, result: { ok: true, value: { paneId: "pane.stub" } } });
        }
        return new Response("not found", { status: 404 });
      }
    });

    try {
      const mod = (await import(cowsayCliUrl)) as {
        default: { run: (args: unknown, ctx: unknown, rawArgs: string[]) => Promise<void> };
      };
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (v: unknown) => {
        logs.push(typeof v === "string" ? v : JSON.stringify(v));
      };
      try {
        await mod.default.run(
          { _: ["moo moo"], origin: `http://127.0.0.1:${server.port}`, title: "moo moo" },
          { dataDir: "C:\\unused" },
          []
        );
      } finally {
        console.log = originalLog;
      }

      expect(calls).toEqual([
        { pathname: "/api/clients", body: null },
        {
          pathname: "/api/model/path/call",
          body: {
            authorityClientId: "stub.client",
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

describe("in-process CLI entitlement", () => {
  it("denies a pane-less extension (no role signal)", () => {
    expect(isInProcessCliEntitled([], () => true)).toBe(false);
  });
  it("permits when the user is allowed at least one of the ext's pane kinds", () => {
    expect(isInProcessCliEntitled(["plot", "terminal"], (k) => k === "plot")).toBe(true);
  });
  it("denies when the user is allowed none of the ext's pane kinds", () => {
    expect(isInProcessCliEntitled(["terminal"], () => false)).toBe(false);
  });
});

describe("invokeInProcessExtensionCli", () => {
  const INPROC = (body: string) =>
    [
      "export default {",
      '  [Symbol.for("flmux.extensionCommand")]: true,',
      "  inProcess: true,",
      '  meta: { name: "cowsay" },',
      `  async run(args, ctx) { ${body} }`,
      "};",
      ""
    ].join("\n");

  async function fixtureExtension(cliSource: string): Promise<DiscoveredLocalExtension> {
    const rootDir = await createCliExtensionFixture({ cliSource });
    const [command] = await discoverLocalCliCommands(rootDir);
    return command!.extension;
  }

  function makeHost(extension: DiscoveredLocalExtension, overrides: Partial<InProcessCliHost> = {}): InProcessCliHost {
    const noopShell = { get: async () => {}, list: async () => {}, set: async () => {}, call: async () => {} };
    return {
      canInvoke: () => true,
      findExtension: (id) => (id === extension.id ? extension : null),
      resolveDataDir: () => "C:\\x",
      createShell: () => noopShell as unknown as ShellClient,
      createConfigLoader: () => async () => ({}) as never,
      ...overrides
    };
  }

  const invoke = (host: InProcessCliHost, argv: string[] = []) =>
    invokeInProcessExtensionCli(host, {
      callerSessionId: "sess-1",
      callerUserId: "u",
      extId: "sample.cowsay",
      argv
    });

  it("invokes an opted-in command and returns its value", async () => {
    const ext = await fixtureExtension(INPROC("return { ok: true, n: 1 };"));
    expect(await invoke(makeHost(ext))).toEqual({ ok: true, n: 1 });
  });

  it("throws forbidden when the gate denies", async () => {
    const ext = await fixtureExtension(INPROC("return 1;"));
    await expect(invoke(makeHost(ext, { canInvoke: () => false }))).rejects.toThrow(/forbidden/);
  });

  it("throws not-invocable for a command that didn't opt in", async () => {
    const rootDir = await createCliExtensionFixture(); // default export: no inProcess
    const ext = (await discoverLocalCliCommands(rootDir))[0]!.extension;
    await expect(invoke(makeHost(ext))).rejects.toThrow(/not in-process callable/);
  });

  it("throws unknown command for an unknown subcommand", async () => {
    const ext = await fixtureExtension(
      [
        'const MARK = Symbol.for("flmux.extensionCommand");',
        "export default {",
        '  [MARK]: true, inProcess: true, meta: { name: "cowsay" },',
        "  async run() {},",
        '  subCommands: { child: { [MARK]: true, inProcess: true, meta: { name: "child" }, async run() { return 1; } } }',
        "};",
        ""
      ].join("\n")
    );
    await expect(invoke(makeHost(ext), ["nope"])).rejects.toThrow(/unknown command/);
  });

  it("throws when the caller session has no shell (reconnect race)", async () => {
    const ext = await fixtureExtension(INPROC("return 1;"));
    await expect(invoke(makeHost(ext, { createShell: () => null }))).rejects.toThrow(/session shell unavailable/);
  });

  it("rejects flags-before-subcommand argv instead of silently running the group", async () => {
    const ext = await fixtureExtension(
      [
        'const MARK = Symbol.for("flmux.extensionCommand");',
        "export default {",
        '  [MARK]: true, inProcess: true, meta: { name: "cowsay" },',
        '  async run() { return "root-ran"; },',
        '  subCommands: { child: { [MARK]: true, inProcess: true, meta: { name: "child" }, async run() { return 1; } } }',
        "};",
        ""
      ].join("\n")
    );
    await expect(invoke(makeHost(ext), ["--bad", "child"])).rejects.toThrow(/unknown command/);
  });

  it("surfaces a parse error even when the session shell is unavailable", async () => {
    const ext = await fixtureExtension(
      [
        "export default {",
        '  [Symbol.for("flmux.extensionCommand")]: true,',
        "  inProcess: true,",
        '  meta: { name: "cowsay" },',
        '  args: { machine: { type: "string", required: true } },',
        "  async run(args) { return args.machine; }",
        "};",
        ""
      ].join("\n")
    );
    await expect(invoke(makeHost(ext, { createShell: () => null }))).rejects.toThrow(/machine/);
  });

  it("scopes ctx.shell to the caller session — its denials surface to the command", async () => {
    const ext = await fixtureExtension(INPROC("return ctx.shell.get('/status/panes');"));
    let seenSid: string | undefined;
    const host = makeHost(ext, {
      createShell: (sid) => {
        seenSid = sid;
        return { get: async (p: string) => Promise.reject(new Error(`denied: ${p}`)) } as unknown as ShellClient;
      }
    });
    await expect(invoke(host)).rejects.toThrow("denied: /status/panes");
    expect(seenSid).toBe("sess-1");
  });

  it("disposes config watchers after run (no leak)", async () => {
    const ext = await fixtureExtension(INPROC("await ctx.loadConfig(() => {}); return 1;"));
    let disposed = 0;
    const host = makeHost(ext, {
      createConfigLoader: (_id, _dir, registerDispose) => async () => {
        registerDispose(() => {
          disposed++;
        });
        return {} as never;
      }
    });
    expect(await invoke(host)).toBe(1);
    expect(disposed).toBe(1);
  });

  it("applies the target command's declared arg defaults", async () => {
    const ext = await fixtureExtension(
      [
        "export default {",
        '  [Symbol.for("flmux.extensionCommand")]: true,',
        "  inProcess: true,",
        '  meta: { name: "cowsay" },',
        '  args: { greeting: { type: "string", default: "hi" } },',
        "  async run(args) { return args.greeting; }",
        "};",
        ""
      ].join("\n")
    );
    expect(await invoke(makeHost(ext))).toBe("hi");
  });

  it("parses argv through citty — positional + coerced boolean flag (subprocess parity)", async () => {
    const ext = await fixtureExtension(
      [
        "export default {",
        '  [Symbol.for("flmux.extensionCommand")]: true,',
        "  inProcess: true,",
        '  meta: { name: "cowsay" },',
        '  args: { name: { type: "positional" }, verbose: { type: "boolean" } },',
        "  async run(args) { return `${args.name}:${args.verbose}`; }",
        "};",
        ""
      ].join("\n")
    );
    expect(await invoke(makeHost(ext), ["alice", "--verbose"])).toBe("alice:true");
  });

  it("walks into a nested inProcess subcommand and returns its value", async () => {
    const ext = await fixtureExtension(
      [
        'const MARK = Symbol.for("flmux.extensionCommand");',
        "export default {",
        '  [MARK]: true, inProcess: true, meta: { name: "cowsay" },',
        '  async run() { return "root"; },',
        '  subCommands: { child: { [MARK]: true, inProcess: true, meta: { name: "child" }, async run() { return "child-ok"; } } }',
        "};",
        ""
      ].join("\n")
    );
    expect(await invoke(makeHost(ext), ["child"])).toBe("child-ok");
  });

  it("rejects a malformed nested command (missing the flmux marker) cleanly", async () => {
    const ext = await fixtureExtension(
      [
        'const MARK = Symbol.for("flmux.extensionCommand");',
        "export default {",
        '  [MARK]: true, inProcess: true, meta: { name: "cowsay" },',
        "  async run() {},",
        "  subCommands: { bad: { inProcess: true, async run() { return 1; } } }",
        "};",
        ""
      ].join("\n")
    );
    await expect(invoke(makeHost(ext), ["bad"])).rejects.toThrow(/not a valid extension command/);
  });

  it("exposes the caller session id as ctx.sessionId", async () => {
    const ext = await fixtureExtension(INPROC("return ctx.sessionId;"));
    expect(await invoke(makeHost(ext))).toBe("sess-1");
  });

  it("rejects before run() when the caller's signal is already aborted", async () => {
    const ext = await fixtureExtension(INPROC("throw new Error('must not run');"));
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));
    await expect(
      invokeInProcessExtensionCli(makeHost(ext), {
        callerSessionId: "sess-1",
        callerUserId: "u",
        extId: "sample.cowsay",
        argv: [],
        signal: controller.signal
      })
    ).rejects.toThrow("caller cancelled");
  });

  it("exposes the caller's signal as ctx.signal — command observes a mid-run abort", async () => {
    const ext = await fixtureExtension(
      INPROC(
        "if (!ctx.signal.aborted) await new Promise((r) => ctx.signal.addEventListener('abort', r)); return 'aborted-seen';"
      )
    );
    const controller = new AbortController();
    const pending = invokeInProcessExtensionCli(makeHost(ext), {
      callerSessionId: "sess-1",
      callerUserId: "u",
      extId: "sample.cowsay",
      argv: [],
      signal: controller.signal
    });
    controller.abort();
    expect(await pending).toBe("aborted-seen");
  });

  it("disposes config watchers even when run() throws", async () => {
    const ext = await fixtureExtension(INPROC("await ctx.loadConfig(() => {}); throw new Error('boom');"));
    let disposed = 0;
    const host = makeHost(ext, {
      createConfigLoader: (_id, _dir, registerDispose) => async () => {
        registerDispose(() => {
          disposed++;
        });
        return {} as never;
      }
    });
    await expect(invoke(host)).rejects.toThrow(/boom/);
    expect(disposed).toBe(1);
  });
});

async function createCliExtensionFixture(
  options: {
    badExport?: boolean;
    recordCtx?: boolean;
    recordCtxInSub?: boolean;
    inProcess?: boolean;
    usesShell?: boolean;
    cliSource?: string;
  } = {}
) {
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

  const runtimeContents = options.cliSource
    ? options.cliSource
    : options.badExport
      ? "export const notADefault = 1;\n"
      : options.inProcess
        ? [
            "export default {",
            '  [Symbol.for("flmux.extensionCommand")]: true,',
            "  inProcess: true,",
            '  meta: { name: "cowsay" },',
            "  async run() { return { ok: true }; }",
            "};",
            ""
          ].join("\n")
        : options.usesShell
          ? [
              "export default {",
              '  [Symbol.for("flmux.extensionCommand")]: true,',
              '  meta: { name: "cowsay" },',
              "  async run(_parsedArgs, ctx) { return ctx.shell.get('/x'); }",
              "};",
              ""
            ].join("\n")
          : options.recordCtx
            ? [
                "export default {",
                '  [Symbol.for("flmux.extensionCommand")]: true,',
                '  meta: { name: "cowsay", description: "Open a cowsay pane" },',
                "  async run(_parsedArgs, ctx) {",
                "    (globalThis.__flmuxCliCtxRecord ?? []).push(ctx);",
                "  }",
                "};",
                ""
              ].join("\n")
            : options.recordCtxInSub
              ? [
                  'const MARK = Symbol.for("flmux.extensionCommand");',
                  "export default {",
                  "  [MARK]: true,",
                  '  meta: { name: "cowsay", description: "Open a cowsay pane" },',
                  "  async run() {},",
                  "  subCommands: {",
                  "    nested: {",
                  "      [MARK]: true,",
                  '      meta: { name: "nested" },',
                  "      async run() {},",
                  "      subCommands: {",
                  "        deeper: {",
                  "          [MARK]: true,",
                  '          meta: { name: "deeper" },',
                  "          async run(_parsedArgs, ctx) {",
                  "            (globalThis.__flmuxCliCtxRecord ?? []).push(ctx);",
                  "          }",
                  "        }",
                  "      }",
                  "    }",
                  "  }",
                  "};",
                  ""
                ].join("\n")
              : [
                  "export default {",
                  '  [Symbol.for("flmux.extensionCommand")]: true,',
                  '  meta: { name: "cowsay", description: "Open a cowsay pane" },',
                  "  async run() {}",
                  "};",
                  ""
                ].join("\n");

  await writeFile(sourceCliEntryPath, "// source stub for discovery\n", "utf8");
  await writeFile(runtimeCliEntryPath, runtimeContents, "utf8");

  return rootDir;
}
