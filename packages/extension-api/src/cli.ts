import type { ArgsDef, CommandDef, ParsedArgs } from "citty";
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

/** Read-only context flmux injects into every extension CLI subcommand. */
export interface FlmuxExtensionCliContext {
  /** Per-extension data dir — `<rootDir>/.flmux/ext/<extId>/`, mkdir'd. */
  readonly dataDir: string;
}

/** Marker symbol identifying a flmux-wrapped CLI command vs a raw citty
 * `CommandDef`. flmux's loader checks for it and injects `ctx` before
 * dispatching to citty. */
export const FLMUX_EXTENSION_COMMAND = Symbol.for("flmux.extensionCommand");

export interface FlmuxExtensionCommand<A extends ArgsDef = ArgsDef> {
  readonly [FLMUX_EXTENSION_COMMAND]: true;
  readonly meta?: CommandDef<A>["meta"];
  readonly args?: A;
  readonly subCommands?: Record<string, FlmuxExtensionCommand>;
  run(parsedArgs: ParsedArgs<A>, ctx: FlmuxExtensionCliContext, rawArgs: string[]): unknown | Promise<unknown>;
}

/**
 * Define an extension CLI subcommand. flmux dispatches it as a citty
 * subcommand and injects `ctx.dataDir` from the extension's identity —
 * extensions never claim their own id at the call site.
 */
export function defineExtensionCommand<A extends ArgsDef>(
  def: Omit<FlmuxExtensionCommand<A>, typeof FLMUX_EXTENSION_COMMAND>
): FlmuxExtensionCommand<A> {
  return { [FLMUX_EXTENSION_COMMAND]: true, ...def };
}

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
 * CommandDefs typically call this inside `run(parsedArgs)`:
 *
 *   const flags = toFlmuxCliFlags(parsedArgs);
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


