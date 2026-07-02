import type { ArgsDef, CommandDef, ParsedArgs } from "citty";
import type { ExtensionConfig, ExtensionConfigBuilder } from "./config";
import type {
  PreferenceReaders,
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
export type { ShellClient } from "./shell";

/** Read-only context flmux injects into every extension CLI subcommand. */
export interface FlmuxExtensionCliContext extends PreferenceReaders {
  /** Per-extension data dir — `<rootDir>/.flmux/ext/<extId>/`, mkdir'd. */
  readonly dataDir: string;
  /** flmux access — use this, not createFlmuxClient. In-process: implicit-current paths
   * (`/panes/current`, `/status/workspace`, …) resolve to the calling session's slot. */
  readonly shell: ShellClient;
  /** Calling session id — in-process only (subprocess has no session). Use to key per-session state. */
  readonly sessionId?: string;
  /** Cancellation, cooperative: fires when the in-process caller aborts. Subprocess: never fires (cancel = process kill). */
  readonly signal: AbortSignal;
  /** Same contract as the server entry's `onInit` (see config.ts). The store
   * lives for this command invocation only — flmux disposes it after `run`,
   * so `watch` has no effect worth using here. */
  loadConfig<T>(build: (builder: ExtensionConfigBuilder<T>) => void): Promise<ExtensionConfig<T>>;
}

/** Marker symbol identifying a flmux-wrapped CLI command vs a raw citty
 * `CommandDef`. flmux's loader checks for it and injects `ctx` before
 * dispatching to citty. */
export const FLMUX_EXTENSION_COMMAND = Symbol.for("flmux.extensionCommand");

export interface FlmuxExtensionCommand<A extends ArgsDef = ArgsDef> {
  readonly [FLMUX_EXTENSION_COMMAND]: true;
  /** Opt in to in-process invocation. run() must use only ctx.shell, return data (no process.exit), and be reentrant. */
  readonly inProcess?: boolean;
  readonly meta?: CommandDef<A>["meta"];
  readonly args?: A;
  readonly subCommands?: Record<string, FlmuxExtensionCommand>;
  run(parsedArgs: ParsedArgs<A>, ctx: FlmuxExtensionCliContext, rawArgs: string[]): unknown | Promise<unknown>;
  /** Optional subprocess-only renderer: flmux streams its lines to stdout after run(); in-process callers get the raw return. */
  readonly format?: (result: unknown, parsedArgs: ParsedArgs<A>) => string | Iterable<string> | AsyncIterable<string>;
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

const echoedOrigins = new Set<string>();

/** One stderr line per origin: which user the token acts as, + warning when
 * that authority has no live window. (stderr, so stdout JSON stays clean.) */
function echoIdentityOnce(origin: string, user: string | null | undefined, liveRenderers: number | undefined): void {
  if (echoedOrigins.has(origin) || !user) return;
  echoedOrigins.add(origin);
  const warn = liveRenderers === 0 ? " ⚠ no live window — changes not visible in any browser" : "";
  console.error(`flmux: user=${user}${warn}`);
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
    user?: string | null;
    clients: Array<{
      authorityClientId: string;
      workspace?: { id?: string; title?: string } | null;
      liveRenderers?: number;
    }>;
  }>(origin, "/api/clients", flags);

  echoIdentityOnce(origin, payload.user, payload.clients[0]?.liveRenderers);

  if (payload.clients.length === 1) return payload.clients[0].authorityClientId;
  if (payload.clients.length === 0) {
    throw new Error("No flmux clients are connected. Start the app first or provide --client <clientId>.");
  }

  const available = payload.clients
    .map((c) => {
      const ws = c.workspace
        ? ` (${c.workspace.id ?? "unknown"}${c.workspace.title ? `: ${c.workspace.title}` : ""})`
        : "";
      return `${c.authorityClientId}${ws}`;
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
        { authorityClientId: await resolveClientId(origin, merged), path },
        flags
      ),
    list: async (path: string): Promise<ShellPathListResult> =>
      modelResultPost(
        origin,
        "/api/model/path/list",
        { authorityClientId: await resolveClientId(origin, merged), path },
        flags
      ),
    set: async (path: string, value: unknown): Promise<ShellPathSetResult> =>
      modelResultPost(
        origin,
        "/api/model/path/set",
        { authorityClientId: await resolveClientId(origin, merged), path, value },
        flags
      ),
    call: async (path: string, args?: Record<string, unknown>): Promise<ShellPathCallResult> =>
      modelResultPost(
        origin,
        "/api/model/path/call",
        { authorityClientId: await resolveClientId(origin, merged), path, args },
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
