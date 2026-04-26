import type { ArgsDef } from "citty";
import type {
  ShellClient,
  ShellPathCallResult,
  ShellPathGetResult,
  ShellPathListResult,
  ShellPathSetResult
} from "./shell";

// Re-export the citty surface extensions need so consumers depend only on
// `@flmux/extension-api` — flmux owns the citty version, extensions stay
// out of the dep graph entirely.
export { defineCommand } from "citty";
export type { ArgsDef, CommandDef, SubCommandsDef } from "citty";

// `resolveColumnFillPlacement` lives in `./placement` (DOM-free) so the
// renderer + server-entry surfaces can reach it from the main
// `@flmux/extension-api` entry too. Re-exported here so existing CLI
// consumers don't have to change their import path.
export { resolveColumnFillPlacement, type PanePlacement } from "./placement";

/**
 * Transport flags that every flmux-aware CLI subcommand accepts. Extensions
 * **must** spread these into their own `args` (`args: { ...commonArgs,
 * myFlag: {...} }`) — citty parses each subcommand in isolation, so an
 * extension CommandDef that omits the spread will have citty reject
 * `--origin`/`--client`/`--token` as unknown options. The user-visible
 * contract is `flmux <cmd> [--origin=X] [--client=Y] [--token=Z] <args>`.
 */
export const commonArgs = {
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
} as const satisfies ArgsDef;

export type FlmuxCliFlags = {
  origin?: string;
  client?: string;
  token?: string;
};

/** Pull just the flmux transport flags from a citty-parsed args record. */
export function toFlmuxCliFlags(args: { origin?: string; client?: string; token?: string }): FlmuxCliFlags {
  return { origin: args.origin, client: args.client, token: args.token };
}

export function resolveOrigin(flags: FlmuxCliFlags): string {
  const origin = flags.origin ?? process.env.FLMUX_ORIGIN;
  if (!origin) {
    throw new Error("Provide --origin <http://127.0.0.1:PORT> or set FLMUX_ORIGIN");
  }
  return origin.replace(/\/+$/, "");
}

function buildAuthHeaders(flags: FlmuxCliFlags): Record<string, string> {
  const token = flags.token ?? process.env.FLMUX_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function apiGet<T>(origin: string, pathname: string, flags: FlmuxCliFlags): Promise<T> {
  const response = await fetch(`${origin}${pathname}`, { headers: buildAuthHeaders(flags) });
  if (!response.ok) {
    throw new Error(`GET ${pathname} failed: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

async function apiPost<T>(origin: string, pathname: string, body: unknown, flags: FlmuxCliFlags): Promise<T> {
  const response = await fetch(`${origin}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...buildAuthHeaders(flags) },
    body: JSON.stringify(body)
  });
  const payload = (await response.json()) as { ok?: boolean; error?: string };
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `POST ${pathname} failed: ${response.status} ${response.statusText}`);
  }
  return payload as T;
}

async function modelResultPost<T = unknown>(
  origin: string,
  pathname: string,
  body: unknown,
  flags: FlmuxCliFlags
): Promise<T> {
  const payload = await apiPost<{ ok: true; result: T }>(origin, pathname, body, flags);
  return payload.result;
}

/**
 * Resolve the concrete clientId to target. If the user passed `--client`
 * (or `FLMUX_CLIENT_ID`) use that; otherwise ask flmux for its connected
 * clients and auto-pick when exactly one is available.
 */
export async function resolveClientId(origin: string, flags: FlmuxCliFlags): Promise<string> {
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

/**
 * Build a `ShellClient` that talks to a running flmux via HTTP. Extension
 * CommandDefs typically call this inside `run({ args })`:
 *
 *   const flags = toFlmuxCliFlags(args);
 *   const client = await createFlmuxClient(flags);
 *   const result = await client.call("/panes/new", { kind: "cowsay" });
 */
export async function createFlmuxClient(flags: FlmuxCliFlags, explicitClientId?: string): Promise<ShellClient> {
  const origin = resolveOrigin(flags);
  const merged = { ...flags, client: explicitClientId ?? flags.client };
  return {
    get: async (path: string): Promise<ShellPathGetResult> =>
      modelResultPost(
        origin,
        "/api/model/path/get",
        { clientId: await resolveClientId(origin, merged), path },
        flags
      ),
    list: async (path: string): Promise<ShellPathListResult> =>
      modelResultPost(
        origin,
        "/api/model/path/list",
        { clientId: await resolveClientId(origin, merged), path },
        flags
      ),
    set: async (path: string, value: unknown): Promise<ShellPathSetResult> =>
      modelResultPost(
        origin,
        "/api/model/path/set",
        { clientId: await resolveClientId(origin, merged), path, value },
        flags
      ),
    call: async (path: string, args?: Record<string, unknown>): Promise<ShellPathCallResult> =>
      modelResultPost(
        origin,
        "/api/model/path/call",
        { clientId: await resolveClientId(origin, merged), path, args },
        flags
      )
  };
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function printError(message: string): void {
  console.error(message);
}


/**
 * Returns `<rootDir>/.flmux/ext/<extensionId>/` from the running flmux,
 * mkdir'd. Throws when the extension isn't loaded.
 */
export async function getExtensionDataDir(client: ShellClient, extensionId: string): Promise<string> {
  if (!extensionId) throw new Error("getExtensionDataDir: extensionId is required");
  // Manifest validator constrains extensionId to `[a-zA-Z0-9._-]+`, so
  // encoding would be a no-op anyway; drop it for consistency with other
  // path-tree helpers (the model's path parser doesn't URL-decode).
  const result = await client.get(`/status/ext/${extensionId}/data-dir`);
  if (!result.ok) {
    throw new Error(`getExtensionDataDir: ${result.code} ${result.error}`);
  }
  if (!result.found || typeof result.value !== "string") {
    throw new Error(`getExtensionDataDir: extension '${extensionId}' is not registered with this flmux instance`);
  }
  return result.value;
}
