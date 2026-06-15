import type { AnyCapDef, ClientOf, ImplOf } from "bunite-core/rpc";
import type { ShellClient } from "./shell";
import type { ExtensionPaneSpec } from "./pane";
import type { ExtensionConfig, ExtensionConfigBuilder } from "./config";

export interface ExtensionServerInitContext {
  dataDir: string;
  /** Build a layered config store (host-provided confkit; see config.ts).
   * Relative file paths resolve against `dataDir`; watcher lifecycle is owned
   * by the host. Call once in `onInit` and share via closure. */
  loadConfig<T>(build: (builder: ExtensionConfigBuilder<T>) => void): Promise<ExtensionConfig<T>>;
}

/** A directory the host grants this session, to mount at `virtual` (a `/w`-rooted
 * path that hides the real location). `mode` is the bind's read/write. */
export interface ExtensionFsBind {
  realPath: string;
  mode: "ro" | "rw";
  virtual: string;
}

/** Filesystem the host grants this session's command sandbox (e.g. an agent's
 * bash). `unconfined` (dev/desktop) = full host fs, no sandbox. Otherwise the
 * sandbox is assembled from `binds` only; empty = no fs access (fail-closed). */
export interface ExtensionFsPolicy {
  unconfined: boolean;
  binds: ExtensionFsBind[];
}

/** Virtual↔real path conversion backed by flmux's own containment (symlink
 * reject + no-follow + canonical pin) — so extensions don't re-implement the
 * security boundary. Available on the session ctx's `fsPolicy`. */
export interface ExtensionFsPathMapper {
  /** Resolve a `/w`-rooted virtual path to its real path + the bind's mode.
   * `read`: full resolve (must exist, symlinks rejected). `write`: resolve the
   * parent and reject a leaf that's a symlink or existing non-file; the caller
   * must still open with `O_NOFOLLOW` (it holds the fd — flmux only returns a
   * path). Throws a host-path-scrubbed error on escape / symlink / not-found /
   * unwritable. */
  toReal(virtual: string, intent: "read" | "write"): { realPath: string; mode: "ro" | "rw" };
  /** Reverse-map a real path to its virtual `/w` path (longest realPath-prefix
   * bind, after canonicalize). `null` if outside every bind. */
  toVirtual(real: string): string | null;
}

/** Per-session context. Identity lives in closure (sessionId/userId free
 *  variables inside the impl), never on the wire. `serve` registers a cap
 *  on the connection scoped to this session; `bootstrap` reaches the same
 *  connection's renderer-served caps (lazy — renderer's `onLoad` registers
 *  after server's `onSession`); `onDispose` runs on conn close. */
export interface ExtensionServerSessionContext {
  dataDir: string;
  sessionId: string;
  userId: string;
  /** Account role (flmux's single source for user→role binding, e.g. `dev`/`tech`/`basic`).
   * `undefined` on desktop (no auth) or for a user with no assigned role. */
  role?: string;
  /** Filesystem the host grants this session — the extension confines its own
   * command execution (e.g. agent bash) to this. See `ExtensionFsPolicy`.
   * Carries the virtual↔real mapper so the extension reuses flmux containment. */
  fsPolicy: ExtensionFsPolicy & ExtensionFsPathMapper;
  /** Mint a session-scoped, user-scoped machine token (+ the local API origin)
   * for calling flmux's HTTP API from a subprocess (e.g. a sandboxed CLI that
   * can't use the in-process `shell` cap). Auto-revoked when the session ends.
   * Web only — `undefined` in desktop (single trusted local user, no auth).
   * Same user scope the extension already holds via `shell`. */
  mintApiToken?(): { origin: string; token: string };
  shell: ShellClient;
  /** Invoke another extension's inProcess CLI command in-process, scoped to this user.
   * argv = canonical subcommand tokens first, then flags/positionals (citty-parsed; only the leaf runs).
   * opts.signal reaches the command as ctx.signal — cancellation is cooperative. */
  invokeExtensionCli(extId: string, argv: string[], opts?: { signal?: AbortSignal }): Promise<unknown>;
  serve<C extends AnyCapDef>(cap: C, impl: ImplOf<C>): void;
  bootstrap<C extends AnyCapDef>(cap: C): Promise<ClientOf<C>>;
  onDispose(fn: () => void): void;
}

export interface ExtensionServerPaneContext {
  dataDir: string;
  shell: ShellClient;
}

export interface ExtensionServerPaneInstance {
  dispose?(): void;
}

// ── HTTP routes (server-entry only) ──
// Serve a dynamic HTTP response at `/api/ext/<extId><path>`. flmux owns the
// security envelope (auth gate, CORS, rate-limit, header filtering, error
// scrubbing); the handler only computes a body. For external packages that
// require a real same-origin HTTP endpoint — security-sensitive comms use cap/RPC.

export type ExtensionHttpMethod = "GET" | "POST";

export interface ExtensionHttpRequest {
  method: ExtensionHttpMethod;
  path: string;
  query: URLSearchParams;
  /** `cookie`/`authorization` are redacted (never leak the session token). */
  header(name: string): string | null;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface ExtensionHttpResponse {
  status?: number;
  /** Filtered to a safe allow-list; `access-control-*`/`set-cookie`/CSP are
   *  dropped — flmux owns CORS so responses stay same-origin. */
  headers?: Record<string, string>;
  body?: string | Uint8Array | ArrayBuffer;
}

export interface ExtensionHttpRouteContext {
  dataDir: string;
  /** User name on `session` routes (`"local"` on desktop); `null` on `public`. */
  userId: string | null;
  request: ExtensionHttpRequest;
}

/** Bare string/bytes ⇒ `{ body }` with content-type `text/plain`. */
export type ExtensionHttpReturn = ExtensionHttpResponse | string | Uint8Array | ArrayBuffer;

export interface ExtensionHttpRoute {
  method: ExtensionHttpMethod;
  path: string; // leading "/", exact-match
  /** `"public"` is GET-only (unauthenticated); `"session"` adds auth + entitlement. */
  auth: "public" | "session";
  handler(ctx: ExtensionHttpRouteContext): ExtensionHttpReturn | Promise<ExtensionHttpReturn>;
}

export interface ExtensionServerDefinition {
  panes?: ExtensionPaneSpec[];
  httpRoutes?: ExtensionHttpRoute[];
  onInit?(ctx: ExtensionServerInitContext): void | Promise<void>;
  onSession?(ctx: ExtensionServerSessionContext): void | Promise<void>;
  onPaneConnected?(
    paneId: string,
    sessionId: string,
    ctx: ExtensionServerPaneContext
  ): ExtensionServerPaneInstance | void | Promise<ExtensionServerPaneInstance | void>;
}

export function defineExtensionServer<T extends ExtensionServerDefinition>(definition: T): T {
  return definition;
}
