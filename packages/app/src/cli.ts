import { defineCommand, runMain, type CommandDef } from "citty";
import { dispatchLocalCliExtensionCommand, discoverLocalCliCommands, defaultExtensionsRootDir } from "./cliExtensions";
import { runTokensCli } from "./cliTokens";
import type {
  ShellClient,
  ShellPathCallResult,
  ShellPathGetResult,
  ShellPathListResult,
  ShellPathSetResult
} from "@flmux/extension-api";

type Flags = {
  origin?: string;
  client?: string;
  token?: string;
};

const commonArgs = {
  origin: {
    type: "string",
    description: "Server origin (http://127.0.0.1:PORT). Falls back to FLMUX_ORIGIN."
  },
  client: {
    type: "string",
    description: "Renderer clientId. Required only when multiple clients are connected."
  },
  token: {
    type: "string",
    description: "Bearer token for authenticated servers. Falls back to FLMUX_TOKEN."
  }
} as const;

const clientsCmd = defineCommand({
  meta: { name: "clients", description: "List connected renderer clients" },
  args: commonArgs,
  async run({ args }) {
    const flags = toFlags(args);
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
    const flags = toFlags(args);
    const origin = resolveOrigin(flags);
    printJson(
      await modelPost(
        origin,
        "/api/model/path/get",
        {
          clientId: await resolveClientId(origin, flags),
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
    const flags = toFlags(args);
    const origin = resolveOrigin(flags);
    printJson(
      await modelPost(
        origin,
        "/api/model/path/list",
        {
          clientId: await resolveClientId(origin, flags),
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
    const flags = toFlags(args);
    const origin = resolveOrigin(flags);
    const clientId = await resolveClientId(origin, flags);
    const listed = await modelPost<{
      ok: true;
      result: { ok: boolean; found?: boolean; entries?: Array<{ path: string }> };
    }>(origin, "/api/model/path/list", { clientId, path: args.path }, flags);

    if (!listed.ok || !listed.result.ok || listed.result.found === false || !listed.result.entries) {
      printJson(listed);
      return;
    }

    const values = Object.fromEntries(
      await Promise.all(
        listed.result.entries.map(async (entry) => {
          const value = await modelPost(origin, "/api/model/path/get", { clientId, path: entry.path }, flags);
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
    const flags = toFlags(args);
    const origin = resolveOrigin(flags);
    // args._ contains all positionals including `path` at [0] and `value` at [1].
    // Extra trailing positionals are joined to support unquoted multi-word values.
    const rawValue = args._.slice(1).join(" ");
    const value = coerceScalar(rawValue || String(args.value));
    printJson(
      await modelPost(
        origin,
        "/api/model/path/set",
        {
          clientId: await resolveClientId(origin, flags),
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
    const flags = toFlags(args);
    const origin = resolveOrigin(flags);
    // args._ has all positionals; path is at [0], key=value args follow.
    const callArgs = parseNamedArgs(args._.slice(1));
    printJson(
      await modelPost(
        origin,
        "/api/model/path/call",
        {
          clientId: await resolveClientId(origin, flags),
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
      "Manage users/tokens (bootstrap | issue | revoke | list | users | qr). Reads users.toml + users.tokens.toml under --auth-dir or <FLMUX_ROOT_DIR>/.flmux/auth."
  },
  // tokens has its own internal subcommand parser; forward raw args as-is.
  async run({ rawArgs }) {
    const result = await runTokensCli(rawArgs);
    if (result !== undefined) {
      printJson(result);
    }
  }
});

const rootCmd = defineCommand({
  meta: {
    name: "flmux",
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
    tokens: tokensCmd as CommandDef
  };

  const extensionCommands = await discoverLocalCliCommands(defaultExtensionsRootDir()).catch(() => []);
  for (const cmd of extensionCommands) {
    if (cmd.commandId in subCommands) continue;
    subCommands[cmd.commandId] = buildExtensionSubCommand(cmd.commandId, cmd.description) as CommandDef;
  }
  return subCommands;
}

function buildExtensionSubCommand(commandId: string, description: string | undefined) {
  return defineCommand({
    meta: { name: commandId, description: description ?? `Extension command '${commandId}'` },
    args: commonArgs,
    async run({ args }) {
      const flags = toFlags(args);
      const origin = resolveOrigin(flags);
      // args._ holds positionals only; common flags are already parsed out.
      await dispatchLocalCliExtensionCommand({
        commandId,
        argv: args._,
        env: process.env as Record<string, string | undefined>,
        cwd: process.cwd(),
        getClient: (clientId) => Promise.resolve(createShellClient(origin, flags, clientId)),
        print: printJson,
        printError: (message) => console.error(message)
      });
    }
  });
}

function toFlags(args: { origin?: string; client?: string; token?: string }): Flags {
  return { origin: args.origin, client: args.client, token: args.token };
}

async function modelPost<T = unknown>(origin: string, pathname: string, body: unknown, flags: Flags): Promise<T> {
  return apiPost<T>(origin, pathname, body, flags);
}

async function modelResultPost<T = unknown>(origin: string, pathname: string, body: unknown, flags: Flags): Promise<T> {
  const payload = await apiPost<{ ok: true; result: T }>(origin, pathname, body, flags);
  return payload.result;
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

function resolveOrigin(flags: Flags) {
  const origin = flags.origin ?? process.env.FLMUX_ORIGIN;
  if (!origin) {
    throw new Error("Provide --origin <http://127.0.0.1:PORT> or set FLMUX_ORIGIN");
  }
  return origin.replace(/\/+$/, "");
}

async function resolveClientId(origin: string, flags: Flags) {
  const explicit = flags.client ?? process.env.FLMUX_CLIENT_ID;
  if (explicit) return explicit;

  const payload = await apiGet<{
    ok: true;
    clients: Array<{ clientId: string; workspace?: { id?: string; title?: string } | null }>;
  }>(origin, "/api/clients", flags);

  if (payload.clients.length === 1) return payload.clients[0].clientId;
  if (payload.clients.length === 0) {
    throw new Error("No flmux clients are connected. Start the app first or provide --client <clientId>.");
  }

  const available = payload.clients
    .map((c) => {
      const ws = c.workspace
        ? ` (${c.workspace.id ?? "unknown"}${c.workspace.title ? `: ${c.workspace.title}` : ""})`
        : "";
      return `${c.clientId}${ws}`;
    })
    .join(", ");
  throw new Error(`Multiple flmux clients are connected. Use --client <clientId>. Available: ${available}`);
}

function createShellClient(origin: string, flags: Flags, explicitClientId?: string): ShellClient {
  const merged = { ...flags, client: explicitClientId ?? flags.client };
  return {
    get: async (path: string): Promise<ShellPathGetResult> =>
      modelResultPost(
        origin,
        "/api/model/path/get",
        {
          clientId: await resolveClientId(origin, merged),
          path
        },
        flags
      ),
    list: async (path: string): Promise<ShellPathListResult> =>
      modelResultPost(
        origin,
        "/api/model/path/list",
        {
          clientId: await resolveClientId(origin, merged),
          path
        },
        flags
      ),
    set: async (path: string, value: unknown): Promise<ShellPathSetResult> =>
      modelResultPost(
        origin,
        "/api/model/path/set",
        {
          clientId: await resolveClientId(origin, merged),
          path,
          value
        },
        flags
      ),
    call: async (path: string, args?: Record<string, unknown>): Promise<ShellPathCallResult> =>
      modelResultPost(
        origin,
        "/api/model/path/call",
        {
          clientId: await resolveClientId(origin, merged),
          path,
          args
        },
        flags
      )
  };
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

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

function buildAuthHeaders(flags: Flags) {
  const token = flags.token ?? process.env.FLMUX_TOKEN;
  const headers: Record<string, string> = {};
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}
