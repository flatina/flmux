import type { CapDef, ClientOf, ImplOf } from "bunite-core/rpc";
import type { ShellClient } from "./shell";
import type { ExtensionPaneSpec } from "./pane";

export interface ExtensionServerInitContext {
  dataDir: string;
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
  serve<C extends CapDef<any, any>>(cap: C, impl: ImplOf<C>): void;
  bootstrap<C extends CapDef<any, any>>(cap: C): Promise<ClientOf<C>>;
  onDispose(fn: () => void): void;
}

export interface ExtensionServerPaneContext {
  dataDir: string;
  shell: ShellClient;
}

export interface ExtensionServerPaneInstance {
  dispose?(): void;
}

export interface ExtensionServerDefinition {
  panes?: ExtensionPaneSpec[];
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
