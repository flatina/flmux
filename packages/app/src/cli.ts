import { dispatchLocalCliExtensionCommand } from "./cliExtensions";
import { runTokensCli } from "./cliTokens";
import type {
  ShellClient,
  ShellPathCallResult,
  ShellPathGetResult,
  ShellPathListResult,
  ShellPathSetResult
} from "@flmux/extension-api";

type BuiltinCommand = "clients" | "get" | "ls" | "ls-each-get" | "set" | "call";

interface Flags {
  origin?: string;
  clientId?: string;
  token?: string;
}

const argv = process.argv.slice(2);
const [command, ...rest] = argv as [string | undefined, ...string[]];

void main(command, rest).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(command: string | undefined, args: string[]) {
  if (!command) {
    throw new Error(usage());
  }

  if (command === "tokens") {
    return printJson(await runTokensCli(args));
  }

  const { positionals, flags } = parseFlags(args);
  const origin = resolveOrigin(flags);

  switch (command as BuiltinCommand) {
    case "clients":
      return printJson(await apiGet<{ ok: true; clients: unknown[] }>(origin, "/api/clients", flags));

    case "get":
      return printJson(await modelPost(origin, "/api/model/path/get", {
        clientId: await resolveClientId(origin, flags),
        path: requirePositional(positionals, 0, "get <path> requires a path")
      }, flags));

    case "ls":
      return printJson(await modelPost(origin, "/api/model/path/list", {
        clientId: await resolveClientId(origin, flags),
        path: requirePositional(positionals, 0, "ls <path> requires a path")
      }, flags));

    case "ls-each-get": {
      const clientId = await resolveClientId(origin, flags);
      const path = requirePositional(positionals, 0, "ls-each-get <path> requires a path");
      const listed = await modelPost<{ ok: true; result: { ok: boolean; found?: boolean; entries?: Array<{ path: string }> } }>(
        origin,
        "/api/model/path/list",
        { clientId, path },
        flags
      );

      if (!listed.ok || !listed.result.ok || listed.result.found === false || !listed.result.entries) {
        return printJson(listed);
      }

      const values = Object.fromEntries(
        await Promise.all(
          listed.result.entries.map(async (entry) => {
            const value = await modelPost(origin, "/api/model/path/get", {
              clientId,
              path: entry.path
            }, flags);
            return [entry.path, value];
          })
        )
      );

      return printJson(values);
    }

    case "set": {
      const clientId = await resolveClientId(origin, flags);
      const path = requirePositional(positionals, 0, "set <path> <value> requires a path");
      if (positionals.length < 2) {
        throw new Error("set <path> <value> requires a value");
      }

      const value = coerceScalar(positionals.slice(1).join(" "));
      return printJson(await modelPost(origin, "/api/model/path/set", { clientId, path, value }, flags));
    }

    case "call": {
      const clientId = await resolveClientId(origin, flags);
      const path = requirePositional(positionals, 0, "call <path> requires a path");
      const args = parseNamedArgs(positionals.slice(1));
      return printJson(await modelPost(origin, "/api/model/path/call", { clientId, path, args }, flags));
    }
  }

  const handledByExtension = await dispatchLocalCliExtensionCommand({
    commandId: command,
    argv: positionals,
    env: process.env as Record<string, string | undefined>,
    cwd: process.cwd(),
    getClient: async (clientId) => createShellClient(origin, flags, clientId),
    print: printJson,
    printError: (message) => console.error(message)
  });
  if (handledByExtension) {
    return;
  }

  throw new Error(usage());
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

function parseFlags(args: string[]) {
  const flags: Flags = {};
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--origin") {
      flags.origin = args[index + 1];
      index += 1;
      continue;
    }

    if (token === "--client") {
      flags.clientId = args[index + 1];
      index += 1;
      continue;
    }

    if (token === "--token") {
      flags.token = args[index + 1];
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return { flags, positionals };
}

function resolveOrigin(flags: Flags) {
  const origin = flags.origin ?? process.env.FLMUX_ORIGIN;
  if (!origin) {
    throw new Error("Provide --origin <http://127.0.0.1:PORT> or set FLMUX_ORIGIN");
  }

  return origin.replace(/\/+$/, "");
}

async function resolveClientId(origin: string, flags: Flags) {
  const explicit = flags.clientId ?? process.env.FLMUX_CLIENT_ID;
  if (explicit) {
    return explicit;
  }

  const payload = await apiGet<{
    ok: true;
    clients: Array<{
      clientId: string;
      workspace?: { id?: string; title?: string } | null;
    }>;
  }>(origin, "/api/clients", flags);

  if (payload.clients.length === 1) {
    return payload.clients[0].clientId;
  }

  if (payload.clients.length === 0) {
    throw new Error("No flmux clients are connected. Start the app first or provide --client <clientId>.");
  }

  const available = payload.clients
    .map((client) => {
      const workspace = client.workspace
        ? ` (${client.workspace.id ?? "unknown"}${client.workspace.title ? `: ${client.workspace.title}` : ""})`
        : "";
      return `${client.clientId}${workspace}`;
    })
    .join(", ");

  throw new Error(`Multiple flmux clients are connected. Use --client <clientId>. Available: ${available}`);
}

function createShellClient(origin: string, flags: Flags, explicitClientId?: string): ShellClient {
  return {
    get: async (path: string): Promise<ShellPathGetResult> => await modelResultPost(origin, "/api/model/path/get", {
      clientId: await resolveClientId(origin, { ...flags, clientId: explicitClientId ?? flags.clientId }),
      path
    }, flags),
    list: async (path: string): Promise<ShellPathListResult> => await modelResultPost(origin, "/api/model/path/list", {
      clientId: await resolveClientId(origin, { ...flags, clientId: explicitClientId ?? flags.clientId }),
      path
    }, flags),
    set: async (path: string, value: unknown): Promise<ShellPathSetResult> => await modelResultPost(origin, "/api/model/path/set", {
      clientId: await resolveClientId(origin, { ...flags, clientId: explicitClientId ?? flags.clientId }),
      path,
      value
    }, flags),
    call: async (path: string, args?: Record<string, unknown>): Promise<ShellPathCallResult> => await modelResultPost(origin, "/api/model/path/call", {
      clientId: await resolveClientId(origin, { ...flags, clientId: explicitClientId ?? flags.clientId }),
      path,
      args
    }, flags)
  };
}

function requirePositional(positionals: string[], index: number, message: string) {
  const value = positionals[index];
  if (!value) {
    throw new Error(message);
  }

  return value;
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
  if (rawValue === "true") {
    return true;
  }

  if (rawValue === "false") {
    return false;
  }

  if (rawValue === "null") {
    return null;
  }

  if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
    return Number(rawValue);
  }

  if (
    (rawValue.startsWith("{") && rawValue.endsWith("}")) ||
    (rawValue.startsWith("[") && rawValue.endsWith("]"))
  ) {
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

function usage() {
  return [
    "Usage:",
    "  bun src/cli.ts clients --origin http://127.0.0.1:PORT",
    "  bun src/cli.ts get /title --origin http://127.0.0.1:PORT",
    "  bun src/cli.ts ls /status/panes --origin http://127.0.0.1:PORT",
    "  bun src/cli.ts ls-each-get /status/panes --origin http://127.0.0.1:PORT",
    "  bun src/cli.ts set /title moo --origin http://127.0.0.1:PORT",
    "  bun src/cli.ts call /panes/new kind=cowsay place=right --origin http://127.0.0.1:PORT",
    "  bun src/cli.ts cowsay hello from cli --origin http://127.0.0.1:PORT",
    "  bun src/cli.ts tokens bootstrap [--name admin] [--allow-pane-kinds \"*\"] [--auth-dir <dir>]",
    "  bun src/cli.ts tokens issue --user <name> [--label <label>] [--expires-at <iso>] [--auth-dir <dir>]",
    "  bun src/cli.ts tokens revoke <tokenId> [--auth-dir <dir>]",
    "  bun src/cli.ts tokens list [--auth-dir <dir>]",
    "  bun src/cli.ts tokens users [--auth-dir <dir>]",
    "  note: --client is only required when multiple renderer clients are connected",
    "  note: use --token <token> or FLMUX_TOKEN when the web server has auth enabled",
    "  note: tokens subcommands read/write users.toml and users.tokens.toml directly (FLMUX_AUTH_DIR or --auth-dir)"
  ].join("\n");
}

function buildAuthHeaders(flags: Flags) {
  const token = flags.token ?? process.env.FLMUX_TOKEN;
  const headers: Record<string, string> = {};
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}
