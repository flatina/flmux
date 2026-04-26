import type { ArgsDef } from "citty";
import type {
  ShellClient,
  ShellPathCallResult,
  ShellPathGetResult,
  ShellPathListResult,
  ShellPathSetResult
} from "./shell";

// Inlined to keep `@flmux/extension-api/cli` typecheck clean for CLI-only
// consumers that don't include the DOM lib — `./pane` declares
// `mount(host: HTMLElement, …)`, so `import type { PanePlacement } from "./pane"`
// would drag in DOM lib failures via type-resolution.
type PanePlacement = "within" | "left" | "right" | "above" | "below";

// Re-export the citty surface extensions need so consumers depend only on
// `@flmux/extension-api` — flmux owns the citty version, extensions stay
// out of the dep graph entirely.
export { defineCommand } from "citty";
export type { ArgsDef, CommandDef, SubCommandsDef } from "citty";

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
 * Compute a `/panes/new` placement that packs new panes into columns of
 * at most `maxRowsPerColumn` rows. Inspects the current workspace via
 * `client.get("/status/workspaces/<id>/panes")`; counts only panes whose
 * `kind` matches `isTargetKind` (other kinds — terminal, browser — are
 * ignored). Heuristic:
 *
 *   target count = 0           →  { place: "right" }                       (1st split)
 *   count % maxRows === 0      →  { place: "right",  referencePaneId: last } (new column)
 *   otherwise                  →  { place: "below",  referencePaneId: last } (extend column)
 *
 * `last` = the most recently created matching pane. The "rightmost column"
 * intuition is a *creation-order proxy*, not a spatial guarantee — after
 * the user drags or closes panes, the most recently created target may no
 * longer live in the rightmost column, and the next placement extends the
 * wrong one. Caller should always allow an explicit `--place` override.
 *
 * Concurrency: not lock-protected. Two CLI invocations racing on the same
 * workspace can both observe the same count and pick the same placement.
 * Acceptable for the human + agent workflow this is intended for; mutual
 * exclusion would have to come from the caller.
 *
 * Pane-ID assumption: relies on `Object.entries` preserving insertion
 * order on the panes map, which JS only guarantees for non-integer-like
 * keys. flmux's pane IDs (`pane_<uuid>`, `pane.<…>`) satisfy this; if a
 * future authority emits all-digit ids, the "last" picked here would be
 * wrong.
 */
export async function resolveColumnFillPlacement(
  client: ShellClient,
  options: {
    workspaceId: string;
    isTargetKind: (kind: string) => boolean;
    maxRowsPerColumn: number;
  }
): Promise<{ place: PanePlacement; referencePaneId?: string }> {
  if (!Number.isInteger(options.maxRowsPerColumn) || options.maxRowsPerColumn <= 0) {
    throw new Error("resolveColumnFillPlacement: maxRowsPerColumn must be a positive integer");
  }
  // No encodeURIComponent — the shell path parser splits on `/` only and
  // doesn't URL-decode segments, so encoding `%20` etc. would hit NOT_FOUND
  // for workspace ids the model otherwise resolves verbatim.
  const result = await client.get(`/status/workspaces/${options.workspaceId}/panes`);
  if (!result.ok) {
    throw new Error(`resolveColumnFillPlacement: ${result.code} ${result.error}`);
  }
  if (
    !result.found ||
    typeof result.value !== "object" ||
    result.value === null ||
    Array.isArray(result.value)
  ) {
    throw new Error(`resolveColumnFillPlacement: workspace '${options.workspaceId}' not found`);
  }
  const targets: string[] = [];
  for (const [paneId, snapshot] of Object.entries(result.value as Record<string, { kind?: unknown }>)) {
    const kind = snapshot?.kind;
    if (typeof kind === "string" && options.isTargetKind(kind)) {
      targets.push(paneId);
    }
  }
  if (targets.length === 0) {
    return { place: "right" };
  }
  const lastId = targets[targets.length - 1]!;
  if (targets.length % options.maxRowsPerColumn === 0) {
    return { place: "right", referencePaneId: lastId };
  }
  return { place: "below", referencePaneId: lastId };
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
