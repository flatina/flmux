import { mkdirSync } from "node:fs";
import { resolve as pathResolve, sep } from "node:path";
import { defineCommand, runMain, type CommandDef } from "citty";
import { browserCmd } from "./cliBrowser";
import { discoverLocalCliCommands, defaultExtensionsRootDir, loadLocalCliCommandDef } from "./cliExtensions";
import { runTokensCli } from "./cliTokens";
import { runAuthCli } from "./cliAuth";
import { resolveFlmuxPaths, resolveFlmuxRootDir, resolveInstallLayout } from "./main/flmuxPaths";
import { commonArgs, printJson, resolveClientId, resolveOrigin, toFlmuxCliFlags } from "@flmux/extension-api/cli";
import type { FlmuxCliFlags } from "@flmux/extension-api/cli";
import { FLMUX_APP_VERSION } from "./version";

type Flags = FlmuxCliFlags;

const clientsCmd = defineCommand({
  meta: { name: "clients", description: "List connected renderer clients" },
  args: commonArgs,
  async run({ args }) {
    const flags = toFlmuxCliFlags(args);
    const origin = resolveOrigin(flags);
    printJson(await apiGet<{ ok: true; clients: unknown[] }>(origin, "/api/clients", flags));
  }
});

const getCmd = defineCommand({
  meta: { name: "get", description: "Read a path via /api/model/path/get" },
  args: {
    ...commonArgs,
    path: { type: "positional", description: "Path (e.g. /status/app/origin)", required: true }
  },
  async run({ args }) {
    const flags = toFlmuxCliFlags(args);
    const origin = resolveOrigin(flags);
    printJson(
      await apiPost(
        origin,
        "/api/model/path/get",
        {
          authorityClientId: await resolveClientId(origin, flags),
          path: args.path
        },
        flags
      )
    );
  }
});

const lsCmd = defineCommand({
  meta: { name: "ls", description: "List entries under a path" },
  args: {
    ...commonArgs,
    path: { type: "positional", description: "Path to list", required: true }
  },
  async run({ args }) {
    const flags = toFlmuxCliFlags(args);
    const origin = resolveOrigin(flags);
    printJson(
      await apiPost(
        origin,
        "/api/model/path/list",
        {
          authorityClientId: await resolveClientId(origin, flags),
          path: args.path
        },
        flags
      )
    );
  }
});

const lsEachGetCmd = defineCommand({
  meta: { name: "ls-each-get", description: "List a path, then get every entry" },
  args: {
    ...commonArgs,
    path: { type: "positional", description: "Path to list", required: true }
  },
  async run({ args }) {
    const flags = toFlmuxCliFlags(args);
    const origin = resolveOrigin(flags);
    const clientId = await resolveClientId(origin, flags);
    const listed = await apiPost<{
      ok: true;
      result: { ok: boolean; found?: boolean; entries?: Array<{ path: string }> };
    }>(origin, "/api/model/path/list", { authorityClientId: clientId, path: args.path }, flags);

    if (!listed.ok || !listed.result.ok || listed.result.found === false || !listed.result.entries) {
      printJson(listed);
      return;
    }

    const values = Object.fromEntries(
      await Promise.all(
        listed.result.entries.map(async (entry) => {
          const value = await apiPost(origin, "/api/model/path/get", { authorityClientId: clientId, path: entry.path }, flags);
          return [entry.path, value];
        })
      )
    );
    printJson(values);
  }
});

const setCmd = defineCommand({
  meta: { name: "set", description: "Write a value to a path" },
  args: {
    ...commonArgs,
    path: { type: "positional", description: "Path to write", required: true },
    value: {
      type: "positional",
      description: "Value (scalar or JSON). Remaining positionals joined by space.",
      required: true
    }
  },
  async run({ args }) {
    const flags = toFlmuxCliFlags(args);
    const origin = resolveOrigin(flags);
    // args._ contains all positionals including `path` at [0] and `value` at [1].
    // Extra trailing positionals are joined to support unquoted multi-word values.
    const rawValue = args._.slice(1).join(" ");
    const value = coerceScalar(rawValue || String(args.value));
    printJson(
      await apiPost(
        origin,
        "/api/model/path/set",
        {
          authorityClientId: await resolveClientId(origin, flags),
          path: args.path,
          value
        },
        flags
      )
    );
  }
});

const callCmd = defineCommand({
  meta: { name: "call", description: "Call an action with key=value args" },
  args: {
    ...commonArgs,
    path: { type: "positional", description: "Path to call", required: true }
  },
  async run({ args }) {
    const flags = toFlmuxCliFlags(args);
    const origin = resolveOrigin(flags);
    // args._ has all positionals; path is at [0], key=value args follow.
    const callArgs = parseNamedArgs(args._.slice(1));
    printJson(
      await apiPost(
        origin,
        "/api/model/path/call",
        {
          authorityClientId: await resolveClientId(origin, flags),
          path: args.path,
          args: callArgs
        },
        flags
      )
    );
  }
});

const tokensCmd = defineCommand({
  meta: {
    name: "tokens",
    description:
      "Manage machine bearer tokens (bootstrap | issue | revoke | list | users). Reads users.toml + users.tokens.toml under --auth-dir or <FLMUX_ROOT_DIR>/.flmux/auth."
  },
  // tokens has its own internal subcommand parser; forward raw args as-is.
  async run({ rawArgs }) {
    const result = await runTokensCli(rawArgs);
    if (result !== undefined) {
      printJson(result);
    }
  }
});

const authCmd = defineCommand({
  meta: {
    name: "auth",
    description:
      "Passkey accounts (create-user | enroll | credentials list|revoke). Enrollment tokens are single-use, short-TTL — deliver over a confidential channel."
  },
  async run({ rawArgs }) {
    const result = await runAuthCli(rawArgs);
    if (result !== undefined) {
      printJson(result);
    }
  }
});

const rootCmd = defineCommand({
  meta: {
    name: "flmux",
    version: FLMUX_APP_VERSION,
    description: "flmux CLI — ShellModelAPI over HTTP (get/ls/set/call) + extension commands"
  },
  subCommands: await buildSubCommands()
});

await runMain(rootCmd);

async function buildSubCommands(): Promise<Record<string, CommandDef>> {
  const subCommands: Record<string, CommandDef> = {
    clients: clientsCmd as CommandDef,
    get: getCmd as CommandDef,
    ls: lsCmd as CommandDef,
    "ls-each-get": lsEachGetCmd as CommandDef,
    set: setCmd as CommandDef,
    call: callCmd as CommandDef,
    tokens: tokensCmd as CommandDef,
    auth: authCmd as CommandDef,
    browser: browserCmd
  };

  // Lazy extension registration: avoid importing every extension's CLI
  // entry on every `flmux ...` invocation. When the user already selected
  // a built-in subcommand, no extension is touched. When the user selected
  // a single extension command, only that one is loaded. `--help` and
  // unknown/empty subcommand paths fall back to loading every extension
  // so the help listing stays complete.
  const invoked = process.argv[2];
  if (invoked && invoked in subCommands) {
    return subCommands;
  }

  const extensionCommands = await discoverLocalCliCommands(defaultExtensionsRootDir()).catch(() => []);
  const isHelpContext = !invoked || invoked === "--help" || invoked === "-h";
  const targetCommandId = isHelpContext ? null : invoked;
  const loadOptions = { resolveExtensionDataDir: createCliDataDirResolver(extensionCommands.map((c) => c.extensionId)) };

  for (const cmd of extensionCommands) {
    if (cmd.commandId in subCommands) continue;
    if (targetCommandId && cmd.commandId !== targetCommandId) continue;
    const def = await loadLocalCliCommandDef(cmd, loadOptions);
    if (def) subCommands[cmd.commandId] = def;
  }
  return subCommands;
}

/**
 * Mirror of main.ts's resolver, scoped to the CLI process. Same install root
 * resolution + same path layout, so server entry's `ctx.dataDir` and the CLI
 * subcommand's `ctx.dataDir` agree on a single directory.
 */
function createCliDataDirResolver(knownExtensionIds: string[]): (extensionId: string) => string | null {
  const { installRoot } = resolveInstallLayout();
  const flmuxPaths = resolveFlmuxPaths(resolveFlmuxRootDir(installRoot));
  const known = new Set(knownExtensionIds);
  const provisioned = new Set<string>();
  const rootResolved = pathResolve(flmuxPaths.extDataRootDir);
  const rootWithSep = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep;
  return (extensionId) => {
    if (!known.has(extensionId)) return null;
    const dir = pathResolve(flmuxPaths.extDataRootDir, extensionId);
    if (!dir.startsWith(rootWithSep)) return null;
    if (!provisioned.has(extensionId)) {
      mkdirSync(dir, { recursive: true });
      provisioned.add(extensionId);
    }
    return dir;
  };
}

async function apiGet<T>(origin: string, pathname: string, flags: Flags): Promise<T> {
  const response = await fetch(`${origin}${pathname}`, {
    headers: buildAuthHeaders(flags)
  });
  if (!response.ok) {
    throw new Error(`GET ${pathname} failed: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

async function apiPost<T>(origin: string, pathname: string, body: unknown, flags: Flags): Promise<T> {
  const response = await fetch(`${origin}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...buildAuthHeaders(flags)
    },
    body: JSON.stringify(body)
  });

  const payload = (await response.json()) as { ok?: boolean; error?: string };
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `POST ${pathname} failed: ${response.status} ${response.statusText}`);
  }

  return payload as T;
}

function parseNamedArgs(tokens: string[]) {
  return Object.fromEntries(
    tokens.map((token) => {
      const split = token.indexOf("=");
      if (split <= 0) {
        throw new Error("call only accepts key=value arguments");
      }
      const key = token.slice(0, split);
      const value = token.slice(split + 1);
      return [key, coerceScalar(value)];
    })
  );
}

function coerceScalar(rawValue: string): unknown {
  if (rawValue === "true") return true;
  if (rawValue === "false") return false;
  if (rawValue === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(rawValue)) return Number(rawValue);
  if ((rawValue.startsWith("{") && rawValue.endsWith("}")) || (rawValue.startsWith("[") && rawValue.endsWith("]"))) {
    try {
      return JSON.parse(rawValue);
    } catch {
      return rawValue;
    }
  }
  return rawValue;
}

function buildAuthHeaders(flags: Flags) {
  const token = flags.token ?? process.env.FLMUX_TOKEN;
  const headers: Record<string, string> = {};
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}
