type Command = "clients" | "get" | "ls" | "ls-each-get" | "set" | "call";

interface Flags {
  origin?: string;
  clientId?: string;
}

const argv = process.argv.slice(2);
const [command, ...rest] = argv as [Command | undefined, ...string[]];

void main(command, rest).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(command: Command | undefined, args: string[]) {
  if (!command) {
    throw new Error(usage());
  }

  const { positionals, flags } = parseFlags(args);
  const origin = resolveOrigin(flags);

  switch (command) {
    case "clients":
      return printJson(await apiGet<{ ok: true; clients: unknown[] }>(origin, "/api/clients"));

    case "get":
      return printJson(await modelPost(origin, "/api/model/path/get", {
        clientId: await resolveClientId(origin, flags),
        path: requirePositional(positionals, 0, "get <path> requires a path")
      }));

    case "ls":
      return printJson(await modelPost(origin, "/api/model/path/list", {
        clientId: await resolveClientId(origin, flags),
        path: requirePositional(positionals, 0, "ls <path> requires a path")
      }));

    case "ls-each-get": {
      const clientId = await resolveClientId(origin, flags);
      const path = requirePositional(positionals, 0, "ls-each-get <path> requires a path");
      const listed = await modelPost<{ ok: true; result: { ok: boolean; found?: boolean; entries?: Array<{ path: string }> } }>(
        origin,
        "/api/model/path/list",
        { clientId, path }
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
            });
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
      return printJson(await modelPost(origin, "/api/model/path/set", { clientId, path, value }));
    }

    case "call": {
      const clientId = await resolveClientId(origin, flags);
      const path = requirePositional(positionals, 0, "call <path> requires a path");
      const args = parseNamedArgs(positionals.slice(1));
      return printJson(await modelPost(origin, "/api/model/path/call", { clientId, path, args }));
    }

    default:
      throw new Error(usage());
  }
}

async function modelPost<T = unknown>(origin: string, pathname: string, body: unknown): Promise<T> {
  return apiPost<T>(origin, pathname, body);
}

async function apiGet<T>(origin: string, pathname: string): Promise<T> {
  const response = await fetch(`${origin}${pathname}`);
  if (!response.ok) {
    throw new Error(`GET ${pathname} failed: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

async function apiPost<T>(origin: string, pathname: string, body: unknown): Promise<T> {
  const response = await fetch(`${origin}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
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

function requireClientId(flags: Flags) {
  const clientId = flags.clientId ?? process.env.FLMUX_CLIENT_ID;
  if (!clientId) {
    throw new Error("Provide --client <clientId> or set FLMUX_CLIENT_ID");
  }

  return clientId;
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
  }>(origin, "/api/clients");

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
    "  note: --client is only required when multiple renderer clients are connected"
  ].join("\n");
}
