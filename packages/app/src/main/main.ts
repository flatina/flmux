import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { delimiter, dirname, resolve, sep } from "node:path";
import {
  BrowserWindow,
  AppRuntime,
  acquireSingleInstanceLock
} from "bunite-core";
import type { Connection } from "bunite-core/rpc";
import type { SequencedShellCoreEvent, ShellModelAPI } from "@flmux/core/shell";
import { shellCap, type FlmuxSessionSaveLayouts } from "../shared/rendererBridge";
import { createShellImpl } from "./shellImpl";
import type { TerminalRuntimeEvent } from "@flmux/core/terminal/types";
import { ClientRegistry } from "./clientRegistry";
import { createSessionStore } from "./sessionStore";
import {
  DESKTOP_CLIENT_ID,
  createDesktopShellAuthority,
  type DesktopShellAuthority
} from "./desktopShellAuthority";
import type { WebModeShellAuthority } from "./webModeShellAuthority";
import { createWebModeUserAuthorityRegistry, type WebModeUserAuthorityRegistry } from "./userAuthorityRegistry";
import { startFlmuxServer } from "./server";
import { forwardTerminalEventToSubscribers } from "./terminalEventForwarding";
import { createTerminalService } from "./terminal-service";
import {
  createFlmuxWebModeAuthorizer,
  type FlmuxAuthorizationContext,
  type FlmuxWebModeAuthorizer
} from "./webModeAuth";
import type { FlmuxUser as FlmuxUserImport } from "./auth/userStore";
import { eventToReadPath } from "./auth/eventAclPath";
import { resolveFlmuxServerPort } from "./auth/serverConfig";
import { resolveFlmuxAppTitle } from "./appConfig";
import { resolveFlmuxRuntimeMode } from "./runtimeMode";
import { resolveFlmuxRootDir, resolveFlmuxPaths } from "./flmuxPaths";
import { ensureFlmuxCliShim, ensureExtensionCliShims } from "./cliShim";
import { FLMUX_APP_VERSION } from "../version";
import { PtydLockFile } from "@flmux/core/terminal/ptyd/lockFile";
import { callJsonRpcIpc } from "@flmux/core/terminal/ptyd/jsonRpcIpc";
import type { FlmuxShellModelRouter } from "./shellModelBridge";
import {
  discoverConfiguredLocalExtensions,
  resolveConfiguredLocalExtensionsRootDir,
  createLocalExtensionLoadEntries
} from "./localExtensions";
import type {
  ExtensionServerClientInstance,
  ExtensionServerDefinition,
  ExtensionServerPaneInstance,
  ShellClient as ShellClientImport
} from "@flmux/extension-api";

type ShellAuthority = Pick<DesktopShellAuthority | WebModeShellAuthority, "subscribe" | "applyTerminalEvent"> & {
  readonly shellModel: ShellModelAPI;
  readonly router: FlmuxShellModelRouter;
  readonly clientId: string;
  persistSession?(layouts: FlmuxSessionSaveLayouts): Promise<void>;
};

const runtimeMode = resolveFlmuxRuntimeMode();
const devAuthAs = readDevAuthAsFlag(Bun.argv);
process.env.BUNITE_REMOTE_DEBUGGING_PORT ??= "9227";
process.env.FLMUX_DEV_MODE ??= Bun.argv.includes("--dev") || devAuthAs ? "1" : "";
const hiddenWindow = process.env.FLMUX_HIDDEN_WINDOW === "1";

function parseOptionalPort(value: string | undefined): number | undefined {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : undefined;
}

function prependFlmuxBinToPath(binDir: string): void {
  // Reuse the existing PATH key's casing (Windows preserves source casing
  // even though the var is case-insensitive); a blind `process.env.PATH =`
  // would create a sibling entry.
  const existingKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH");
  const key = existingKey ?? "PATH";
  const current = existingKey ? process.env[existingKey] : undefined;
  process.env[key] = current ? `${binDir}${delimiter}${current}` : binDir;
}

function readDevAuthAsFlag(argv: readonly string[]): string | undefined {
  const i = argv.indexOf("--dev-auth-as");
  if (i < 0 || i + 1 >= argv.length) return undefined;
  const value = argv[i + 1]?.trim();
  // Reject the next arg if it looks like another flag — prevents
  // `--dev-auth-as --web` from silently enabling the bypass as user "--web".
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

// Mirrors bunite's internal `getBaseDir()` (shared/paths.ts): use the
// entry-script dir in dev, the binary dir when compiled. This lets web
// mode resolve renderer assets without constructing `AppRuntime` (which
// boots CEF). Desktop mode would normally pull the same result through
// `app.resolve(...)`; we keep one code path so both modes agree.
const baseDir = Bun.main && existsSync(Bun.main) ? dirname(Bun.main) : dirname(process.execPath);
const rendererDir = resolve(baseDir, "../dist/renderer");
const installRoot = resolve(baseDir, "../../..");
const flmuxPaths = resolveFlmuxPaths(resolveFlmuxRootDir(installRoot));
const projectDir = flmuxPaths.rootDir;
const localExtensionsRootDir = resolveConfiguredLocalExtensionsRootDir(resolve(baseDir, "../../../extensions"));

const instanceLockKey = (() => {
  try {
    return realpathSync.native(flmuxPaths.rootDir);
  } catch {
    return flmuxPaths.rootDir;
  }
})();
const instanceLock = acquireSingleInstanceLock(`flmux:${instanceLockKey}`);
if (!instanceLock.acquired) {
  const holder = instanceLock.holderPid ? ` (pid ${instanceLock.holderPid})` : "";
  console.error(`flmux is already running for ${flmuxPaths.rootDir}${holder}.`);
  process.exit(1);
}

// Only desktop mode needs the CEF runtime. Web mode runs as a headless
// Bun server and instantiating AppRuntime eagerly would boot CEF for
// nothing (bunite's `new AppRuntime` triggers `initNativeRuntime`). Pin
// CEF's userDataDir to our `.flmux/cef-userdata/` so cookies / shader
// cache live alongside the rest of flmux state (tests override via
// BUNITE_USER_DATA_DIR for per-run isolation).
// CEF native code requires userDataDir to exist before boot — the mkdtemp
// tests used to provide this implicitly. `mkdirSync` here recursively
// creates `<rootDir>/.flmux/cef-userdata/` if absent.
if (runtimeMode === "desktop") {
  mkdirSync(flmuxPaths.cefUserDataDir, { recursive: true });
}

// Write `<rootDir>/.flmux/bin/flmux{,.cmd}` pointing at this install's CLI
// entry so terminal panes (which prepend `.flmux/bin` to PATH) can invoke
// `flmux <cmd>` against the version that owns their rootDir. Skipped with a
// warning when the layout can't be resolved — the empty dir is harmless.
const shimResult = ensureFlmuxCliShim({ binDir: flmuxPaths.binDir, baseDir });
if (!shimResult.ok) {
  console.warn(`[flmux] cli shim skipped (${shimResult.reason})`);
}

// Mirror the env terminal panes get into the flmux process itself so
// extension server entries (and anything else flmux spawns) inherit
// `<.flmux/bin>` on PATH and `FLMUX_ROOT` — making `flmux <cmd>` reachable
// without each extension reconstructing the path.
process.env.FLMUX_ROOT = flmuxPaths.rootDir;
prependFlmuxBinToPath(flmuxPaths.binDir);
const app =
  runtimeMode === "desktop"
    ? (() => {
        process.env.BUNITE_CEF_DIR ??= resolve(installRoot, "dist/cef");
        return new AppRuntime({
          logLevel: "info",
          userDataDir: flmuxPaths.cefUserDataDir
        });
      })()
    : null;
if (app) await app.ready;

const clientGraceEnvMs = Number.parseInt(process.env.FLMUX_CLIENT_GRACE_MS ?? "", 10);
const clientRegistry = new ClientRegistry(
  Number.isFinite(clientGraceEnvMs) && clientGraceEnvMs > 0 ? { graceMs: clientGraceEnvMs } : undefined
);
const terminalService = createTerminalService();
const sessionStore = runtimeMode === "desktop" ? createSessionStore({ filePath: flmuxPaths.desktopSessionFile }) : null;
// paneId → set of stream emit callbacks (one per `shell.terminalEvents`
// stream consumer). Terminal events fan out to every emitter so multiple
// tabs of the same user can share a pane. Stream abort removes the emitter
// from the Set; `pane.removed` clears the whole entry.
const paneEmitters = new Map<string, Set<(event: TerminalRuntimeEvent) => void>>();
const localExtensions = await discoverConfiguredLocalExtensions(localExtensionsRootDir);

const knownExtensionIds = new Set(localExtensions.map((ext) => ext.id));
const provisionedExtensionDirs = new Set<string>();
const extDataRootResolved = resolve(flmuxPaths.extDataRootDir);
function resolveExtensionDataDir(extensionId: string): string | null {
  if (!knownExtensionIds.has(extensionId)) return null;
  const dir = resolve(flmuxPaths.extDataRootDir, extensionId);
  // Defense in depth: validator rejects path-segment chars in ids, but
  // re-verify the join stays under extDataRootDir so a validator
  // regression can't escape into auth/, tmp/, etc.
  const rootWithSep = extDataRootResolved.endsWith(sep) ? extDataRootResolved : extDataRootResolved + sep;
  if (!dir.startsWith(rootWithSep)) return null;
  if (!provisionedExtensionDirs.has(extensionId)) {
    mkdirSync(dir, { recursive: true });
    provisionedExtensionDirs.add(extensionId);
  }
  return dir;
}

// Per-extension PATH shims (opt-in via manifest `commands[].shim`). Requires
// the flmux shim pair to have resolved — shares its bun + cli entry so both
// point at the same install.
if (shimResult.ok && shimResult.entry && shimResult.bunCommand) {
  const extensionShims = ensureExtensionCliShims({
    binDir: flmuxPaths.binDir,
    bunCommand: shimResult.bunCommand,
    cliEntry: shimResult.entry,
    extensions: localExtensions.map((ext) => ({
      extensionId: ext.id,
      commands: ext.runtimeManifest.commands
    }))
  });
  for (const skip of extensionShims.skipped) {
    console.warn(`[flmux] extension '${skip.extensionId}' shim '${skip.name}' skipped (${skip.reason})`);
  }
}

// Extension server entries: imported once, registered per (paneId, clientId)
// subscription. Module-level state lives inside the extension's server module
// (e.g. a cache keyed by paneId) — flmux only wires the transport channel.
const extensionServers = new Map<string, ExtensionServerDefinition>();
const extensionServerInits = new Map<string, Promise<void>>();
for (const ext of localExtensions) {
  if (!ext.serverEntryRelativePath) continue;
  try {
    const url = await ext.resolveEntryImportUrl(ext.serverEntryRelativePath);
    if (!url) continue;
    const mod = (await import(url)) as { default?: ExtensionServerDefinition };
    const def = mod.default;
    if (!def) continue;
    extensionServers.set(ext.id, def);
    if (def.onInit) {
      const dataDir = resolveExtensionDataDir(ext.id);
      if (!dataDir) {
        console.warn(`[flmux] extension '${ext.id}' onInit skipped — data dir not provisioned; server entry disabled`);
        extensionServers.delete(ext.id);
        continue;
      }
      const initPromise = (async () => {
        try {
          await def.onInit!({ dataDir });
        } catch (err) {
          console.warn(`[flmux] extension '${ext.id}' onInit failed; server entry disabled:`, err);
          extensionServers.delete(ext.id);
        }
      })();
      extensionServerInits.set(ext.id, initPromise);
    }
  } catch (err) {
    console.warn(`[flmux] failed to load server entry for extension '${ext.id}':`, err);
  }
}

// Per-(extension × client) RPC binding instance from `onClientConnected`.
// `null` means the hook returned void — sentinel keeps idempotency.
const extensionClientInstances = new Map<string, ExtensionServerClientInstance | null>();
// Per-(extension × client) bind promise — pane-level dispatch awaits this so
// `onPaneConnected` never fires before `onClientConnected` resolves.
const extensionClientBindPromises = new Map<string, Promise<void>>();
// Per-(paneId × clientId) `onPaneConnected` instance. No RPC concerns —
// pane-lifecycle bookkeeping only.
const paneServerInstances = new Map<string, ExtensionServerPaneInstance>();
const paneKinds = new Map<string, string>();
// clientId → live bunite Connection for that client. Extensions serve their
// caps on this Connection in `onClientConnected`; flmux owns the
// `flmux.shell` registration. Set at register-time, deleted on disconnect.
const clientIdToConnection = new Map<string, Connection>();
// Pre-register viewId → Connection map. Populated when a WS opens (web) or
// the desktop view is constructed; consumed by `registerClient` to bind
// `clientIdToConnection`. Desktop's viewId is `win.webviewId`; web mints
// sequentially.
const viewIdToConnection = new Map<number, Connection>();

function findExtensionIdForPaneKind(kind: string): string | undefined {
  return localExtensions.find((ext) => ext.runtimeManifest.panes?.some((p) => p.kind === kind))?.id;
}

function paneInstanceKey(extId: string, paneId: string, clientId: string) {
  return `${extId}::${paneId}::${clientId}`;
}

function clientInstanceKey(extId: string, clientId: string) {
  return `${extId}::${clientId}`;
}

/**
 * ACL-aware ShellClient for an extension server entry. Calls route through
 * the same `allow_paths` + `allow_pane_kinds` gates as HTTP. Desktop
 * (no authorizer) grants through, same as preload/WS trust.
 *
 * Returns null when the pane→authority mapping isn't established yet
 * (racing `clientIdToConnection` writes); caller warns and retries.
 */
function createExtensionShellClient(paneId: string | null, clientId: string): ShellClientImport | null {
  const authority = paneId ? paneIdToAuthority.get(paneId) : resolveAuthorityForClient(clientId);
  if (!authority) return null;
  const shellModel = authority.shellModel;
  const authorizer = webModeAuthorizer;
  const caller: { clientId: string; sourcePaneId?: string } = paneId ? { clientId, sourcePaneId: paneId } : { clientId };

  // Per-call resolve: session cleanup / token revocation drops ACL on the
  // next shell call instead of using a stale snapshot.
  function resolveUser(): FlmuxUserImport | null {
    if (!authorizer) return null;
    const userId = clientIdToUserId.get(clientId);
    if (!userId) return null;
    return authorizer.resolveUserByName(userId);
  }

  function assertAllowed(method: "read" | "write" | "call", path: string) {
    if (!authorizer) return;
    const user = resolveUser();
    if (!user) {
      // Fail closed when the client's user can't be identified.
      throw new Error(`No resolvable user for client '${clientId}' (shell ${method} '${path}')`);
    }
    if (!authorizer.isPathAllowed(user, method, path)) {
      throw new Error(`Access denied for user '${user.name}': ${method} '${path}'`);
    }
  }

  function assertPaneKindAllowed(path: string, args: Record<string, unknown> | undefined) {
    if (!authorizer || path !== "/panes/new") return;
    const kind = typeof args?.kind === "string" ? args.kind : null;
    if (!kind) return;
    const user = resolveUser();
    if (!user) return; // already thrown from assertAllowed earlier
    if (!authorizer.isPaneKindAllowed(user, kind)) {
      throw new Error(`User '${user.name}' is not allowed to create pane kind '${kind}'`);
    }
  }

  return {
    async get(path) {
      assertAllowed("read", path);
      return shellModel.pathGet(path, caller);
    },
    async list(path) {
      assertAllowed("read", path);
      return shellModel.pathList(path, caller);
    },
    async set(path, value) {
      assertAllowed("write", path);
      return shellModel.pathSet(path, value, caller);
    },
    async call(path, args) {
      assertAllowed("call", path);
      assertPaneKindAllowed(path, args);
      return shellModel.pathCall(path, args, caller);
    }
  };
}

/**
 * Attach extension server to a client — fires `onClientConnected` once per
 * (extension × client). Idempotent: stores a bind promise so concurrent
 * pane-level dispatch awaits the same handshake. Per-extension `onInit`
 * promise is awaited first; init failure cascades to skipping this attach.
 *
 * Extensions wire RPC via `ctx.connection.serve(extCap, impl)` inside
 * `onClientConnected`. flmux owns the Connection lifecycle; extensions own
 * their cap registration via the returned instance's `dispose`.
 */
function attachExtensionServer(extId: string, clientId: string): Promise<void> {
  const key = clientInstanceKey(extId, clientId);
  const existing = extensionClientBindPromises.get(key);
  if (existing) return existing;
  const initPromise = extensionServerInits.get(extId);
  const server = extensionServers.get(extId);
  if (!server?.onClientConnected) return Promise.resolve();
  const connection = clientIdToConnection.get(clientId);
  if (!connection) return Promise.resolve();
  const shell = createExtensionShellClient(null, clientId);
  if (!shell) {
    console.warn(
      `[flmux] extension '${extId}' skipped onClientConnected — no authority mapped for client ${clientId}`
    );
    return Promise.resolve();
  }
  const dataDir = resolveExtensionDataDir(extId);
  if (!dataDir) {
    console.warn(`[flmux] extension '${extId}' skipped onClientConnected — data dir not provisioned`);
    return Promise.resolve();
  }
  let promise!: Promise<void>;
  promise = (async () => {
    if (initPromise) await initPromise;
    if (
      extensionServers.get(extId) !== server ||
      extensionClientBindPromises.get(key) !== promise ||
      clientIdToConnection.get(clientId) !== connection
    ) {
      return;
    }
    try {
      const inst = await server.onClientConnected!(clientId, { dataDir, shell, connection });
      if (extensionClientBindPromises.get(key) !== promise) {
        try {
          inst?.dispose?.();
        } catch (err) {
          console.warn(`[flmux] extension '${extId}' late dispose error (client ${clientId}):`, err);
        }
        return;
      }
      extensionClientInstances.set(key, inst ?? null);
    } catch (err) {
      console.warn(`[flmux] extension '${extId}' onClientConnected error (client ${clientId}):`, err);
    }
  })();
  extensionClientBindPromises.set(key, promise);
  return promise;
}

async function detachExtensionServer(extId: string, clientId: string) {
  const key = clientInstanceKey(extId, clientId);
  const pending = extensionClientBindPromises.get(key);
  // Mark cancelled before awaiting so the bind continuation drops itself.
  extensionClientBindPromises.delete(key);
  if (pending) await pending;
  // After the await, a fresh `attachExtensionServer` may have taken the slot
  // (cookie continuity rebind in the same sync slice). The new bind owns
  // the instance now — don't dispose its handle.
  if (extensionClientBindPromises.has(key)) return;
  if (!extensionClientInstances.has(key)) return;
  const inst = extensionClientInstances.get(key);
  extensionClientInstances.delete(key);
  try {
    inst?.dispose?.();
  } catch (err) {
    console.warn(`[flmux] extension '${extId}' onClientConnected dispose error (client ${clientId}):`, err);
  }
}

/**
 * Per-pane lifecycle notification. Awaits the (ext × client) bind promise
 * so `onPaneConnected` never sees a half-bound state. Re-checks demux after
 * the await — client disconnect during the bind gates pane attach.
 */
async function attachExtensionServerPane(paneId: string, kind: string, clientId: string) {
  const extId = findExtensionIdForPaneKind(kind);
  if (!extId) return;
  await attachExtensionServer(extId, clientId);
  if (!clientIdToConnection.has(clientId)) return;
  const server = extensionServers.get(extId);
  if (!server?.onPaneConnected) return;
  const shell = createExtensionShellClient(paneId, clientId);
  if (!shell) return;
  const dataDir = resolveExtensionDataDir(extId);
  if (!dataDir) return;
  const key = paneInstanceKey(extId, paneId, clientId);
  if (paneServerInstances.has(key)) return;
  try {
    const inst = await server.onPaneConnected(paneId, clientId, { shell, dataDir });
    if (!clientIdToConnection.has(clientId)) {
      // Late disconnect during onPaneConnected — drop instead of stranding.
      try {
        inst?.dispose?.();
      } catch (err) {
        console.warn(`[flmux] extension '${extId}' late pane dispose error (pane ${paneId}, client ${clientId}):`, err);
      }
      return;
    }
    if (inst) paneServerInstances.set(key, inst);
  } catch (err) {
    console.warn(`[flmux] extension '${extId}' onPaneConnected error (pane ${paneId}, client ${clientId}):`, err);
  }
}

function detachExtensionServerPane(paneId: string, kind: string, clientId: string) {
  const extId = findExtensionIdForPaneKind(kind);
  if (!extId) return;
  const key = paneInstanceKey(extId, paneId, clientId);
  const inst = paneServerInstances.get(key);
  if (!inst) return;
  try {
    inst.dispose?.();
  } catch (err) {
    console.warn(`[flmux] extension '${extId}' onPaneConnected dispose error (pane ${paneId}, client ${clientId}):`, err);
  }
  paneServerInstances.delete(key);
}
const webModeAuthPaths =
  runtimeMode === "web"
    ? {
        authDir: flmuxPaths.authDir,
        usersFile: flmuxPaths.usersFile,
        tokensFile: flmuxPaths.tokensFile
      }
    : null;
const webModeAuthorizer = webModeAuthPaths ? createFlmuxWebModeAuthorizer(webModeAuthPaths, { devAuthAs }) : null;
if (devAuthAs && runtimeMode === "web") {
  console.warn(`[flmux] [!] DEV AUTH: all web requests authenticated as '${devAuthAs}' — do not use in production`);
} else if (devAuthAs) {
  console.warn(`[flmux] --dev-auth-as has no effect in ${runtimeMode} mode; ignored`);
}

const desktopAuthority: DesktopShellAuthority | null =
  runtimeMode === "desktop" && sessionStore
    ? await createDesktopShellAuthority({
        projectDir,
        runtimeLabel: "desktop local-http preload ok",
        appVersion: FLMUX_APP_VERSION,
        initialAppTitle: resolveFlmuxAppTitle(flmuxPaths.appConfigFile),
        terminalService,
        sessionStore,
        clientRegistry,
        localExtensions,
        cefCdpPort: parseOptionalPort(process.env.BUNITE_REMOTE_DEBUGGING_PORT)
      })
    : null;

let serverOrigin = "";

// Web mode: `Map<userId, WebModeShellAuthority>`. Each authenticated user
// gets an isolated `ShellCore` on first reach. Session persistence is NOT
// per-user yet — desktop keeps its single `sessionStore`, web has none
// (B2 Phase 2+ concern).
const userAuthorityRegistry: WebModeUserAuthorityRegistry | null =
  runtimeMode === "web"
    ? createWebModeUserAuthorityRegistry({
        projectDir,
        appVersion: FLMUX_APP_VERSION,
        initialAppTitle: resolveFlmuxAppTitle(flmuxPaths.appConfigFile),
        terminalService,
        clientRegistry,
        localExtensions,
        getOrigin: () => serverOrigin,
        onAuthorityCreated: (_userId, authority) => {
          trackPaneLifecycle(authority);
        },
        onAuthorityEvicted: (_userId, authority) => {
          paneLifecycleUnsubs.get(authority)?.();
          paneLifecycleUnsubs.delete(authority);
          for (const [paneId, owner] of paneIdToAuthority.entries()) {
            if (owner === authority) paneIdToAuthority.delete(paneId);
          }
          // Cancel any pending debounce so we don't write through a
          // freshly-evicted authority (sessionStore.save would still
          // succeed, but the work is wasted).
          const timer = debounceTimerByAuthority.get(authority as PersistingAuthority);
          if (timer) {
            clearTimeout(timer);
            debounceTimerByAuthority.delete(authority as PersistingAuthority);
            pendingLayoutsByAuthority.delete(authority as PersistingAuthority);
          }
        },
        // Per-user session persistence under the auth dir — each
        // authenticated user gets `<authDir>/sessions/<userId>/session.json`.
        sessionsDir: runtimeMode === "web" ? flmuxPaths.webSessionsDir : undefined
      })
    : null;

/** Authority-eviction grace: after a user's last client evicts, wait
 * this long before tearing down their authority. Gives legitimate tab
 * refresh + next-login windows time to reconnect without paying the
 * cost of a full ShellCore rebuild. Tunable; 5 min is the default dev
 * value.
 *
 * When token revocation lands: narrowing a user's `allow_paths` should
 * close each of that user's live WS clients with close-code 4001
 * (FLMUX_CLOSE_POLICY_CHANGED). The browser's WS close handler then
 * triggers a fresh `/api/shell/bootstrap` → new clientId under new
 * policy, piggybacking on the existing `rebootstrap-required` path.
 * Intentionally NOT implemented as a synthetic shellCore.event — that
 * would muddy the "events describe shell state" contract from B1b. */
const authorityGraceEnvMs = Number.parseInt(process.env.FLMUX_AUTHORITY_EVICTION_GRACE_MS ?? "", 10);
const AUTHORITY_EVICTION_GRACE_MS =
  Number.isFinite(authorityGraceEnvMs) && authorityGraceEnvMs > 0 ? authorityGraceEnvMs : 5 * 60 * 1000;
const pendingAuthorityEvictionByUser = new Map<string, ReturnType<typeof setTimeout>>();

function countUserClients(userId: string): number {
  let count = 0;
  for (const owner of clientIdToUserId.values()) {
    if (owner === userId) count += 1;
  }
  return count;
}

function cancelPendingAuthorityEviction(userId: string) {
  const timer = pendingAuthorityEvictionByUser.get(userId);
  if (timer) {
    clearTimeout(timer);
    pendingAuthorityEvictionByUser.delete(userId);
  }
}

function maybeScheduleAuthorityEviction(userId: string) {
  if (!userAuthorityRegistry) return;
  if (countUserClients(userId) > 0) return;
  cancelPendingAuthorityEviction(userId);
  const timer = setTimeout(() => {
    pendingAuthorityEvictionByUser.delete(userId);
    // Re-check: a new client may have been minted during the grace.
    if (countUserClients(userId) > 0) return;
    const evicted = userAuthorityRegistry.evict(userId);
    if (evicted) {
      console.log(`[flmux] authority for user '${userId}' evicted after client grace`);
    }
  }, AUTHORITY_EVICTION_GRACE_MS);
  pendingAuthorityEvictionByUser.set(userId, timer);
}

// Mode exclusivity guard: `resolveAuthorityForViewId` branches on
// `desktopAuthority` first, which is safe only when exactly one of the
// two is configured. A mixed-mode misconfiguration would silently route
// every web viewId to the desktop authority.
if ((desktopAuthority === null) === (userAuthorityRegistry === null)) {
  throw new Error(
    `Exactly one of desktopAuthority/userAuthorityRegistry must be configured (runtime mode: '${runtimeMode}')`
  );
}

const viewIdToClientId = new Map<number, string>();
// Web-only: records which user owns each minted clientId so WS
// register + shellModel.path.* calls route to the right authority.
const clientIdToUserId = new Map<string, string>();
// Terminal event routing index: paneId → owning authority. Replaces the
// naive fan-out-to-every-authority pattern so terminal events apply to
// exactly the authority that owns the pane, not every authority whose
// ShellCore happens to lack the id. Kept in sync via pane.added /
// pane.removed subscribers installed once per authority (desktop at
// startup, web on first getOrCreate via the registry's onAuthorityCreated
// hook).
const paneIdToAuthority = new Map<string, ShellAuthority>();
// Lifecycle-subscription unsubs keyed by the tracked authority — so we
// can tear down the subscription at authority eviction without leaking
// a shellCore subscriber for the process lifetime.
const paneLifecycleUnsubs = new WeakMap<ShellAuthority, () => void>();

function trackPaneLifecycle(authority: ShellAuthority): () => void {
  const unsub = authority.subscribe((event) => {
    if (event.topic === "pane.added") {
      const { paneId, snapshot } = event.payload;
      paneIdToAuthority.set(paneId, authority);
      paneKinds.set(paneId, snapshot.kind);
      for (const [clientId] of clientIdToConnection) {
        if (resolveAuthorityForClient(clientId) === authority) {
          void attachExtensionServerPane(paneId, snapshot.kind, clientId);
        }
      }
    } else if (event.topic === "pane.removed") {
      const { paneId } = event.payload;
      paneIdToAuthority.delete(paneId);
      const kind = paneKinds.get(paneId);
      if (kind) {
        for (const [clientId] of clientIdToConnection) {
          detachExtensionServerPane(paneId, kind, clientId);
        }
        paneKinds.delete(paneId);
      }
    }
  });
  paneLifecycleUnsubs.set(authority, unsub);
  return unsub;
}

// After a client's demux is installed: attach extension servers (per ext)
// then attach existing panes (per pane × ext × client). Used at:
//   - desktop boot (demux created after session restore panes land)
//   - web client bind (demux at WS open, clientId at register)
function retroattachAllPanesForClient(clientId: string) {
  const authority = resolveAuthorityForClient(clientId);
  if (!authority) return;
  for (const [extId] of extensionServers) {
    void attachExtensionServer(extId, clientId);
  }
  for (const [paneId, kind] of paneKinds) {
    if (paneIdToAuthority.get(paneId) === authority) {
      void attachExtensionServerPane(paneId, kind, clientId);
    }
  }
}

function detachAllPanesForClient(clientId: string) {
  // LIFO teardown: panes (innermost) first, then per-extension client state.
  // Mirrors setup order (client → pane) so per-pane handlers can still touch
  // per-client state during their dispose.
  const keyPrefix = `::`;
  for (const key of [...paneServerInstances.keys()]) {
    if (!key.endsWith(keyPrefix + clientId)) continue;
    const inst = paneServerInstances.get(key);
    try {
      inst?.dispose?.();
    } catch (err) {
      console.warn(`[flmux] extension dispose error (key ${key}):`, err);
    }
    paneServerInstances.delete(key);
  }
  for (const [extId] of extensionServers) {
    void detachExtensionServer(extId, clientId);
  }
  clientIdToConnection.delete(clientId);
}

function scopeMatches(event: SequencedShellCoreEvent, clientId: string): boolean {
  if (event.scope === "all") return true;
  return event.targetClientId === clientId;
}

/**
 * Broadcast-forwarder ACL gate (B3): event is only delivered if the
 * client's user can read the path the event corresponds to. Desktop
 * mode (no authorizer) and users with `allow_paths = "*"` pass through.
 * Unmapped events (structural, no specific path) pass through too.
 */
function isEventAllowedForClient(
  authorizer: FlmuxWebModeAuthorizer | null,
  clientId: string,
  event: SequencedShellCoreEvent
): boolean {
  // Fail-open on user-resolution miss (vs. assertAllowed's fail-closed): avoids teardown-race throws in the broadcast loop.
  if (!authorizer) return true;
  const userId = clientIdToUserId.get(clientId);
  if (!userId) return true;
  const user = authorizer.getUser(userId);
  if (!user) return true;
  const path = eventToReadPath(event);
  if (path === null) return true;
  return authorizer.isPathAllowed(user, "read", path);
}

/**
 * Resolve the authority an client belongs to. Desktop has a single
 * authority and ignores `clientId`; web looks up the owning user via
 * the bootstrap-time mapping. Returns null in web mode if the client
 * is unknown (e.g. stale cookie after server restart).
 */
function resolveAuthorityForClient(clientId: string): ShellAuthority | null {
  if (desktopAuthority) return desktopAuthority;
  const userId = clientIdToUserId.get(clientId);
  if (!userId) return null;
  return userAuthorityRegistry?.get(userId) ?? null;
}

function resolveAuthorityForViewId(viewId: number, hints?: { clientId?: string }): ShellAuthority | null {
  if (desktopAuthority) return desktopAuthority;
  const clientId = hints?.clientId ?? viewIdToClientId.get(viewId);
  if (!clientId) return null;
  return resolveAuthorityForClient(clientId);
}

/**
 * Install the always-on ring-buffer subscriber for `clientId`. Called
 * at client creation time (desktop preload register, web HTTP bootstrap)
 * so the buffer is alive from the moment the client exists — including
 * the window between `/api/shell/bootstrap` response and the browser's WS
 * `flmux.client.register` call. Idempotent.
 */
/**
 * Subscribe to the client's authority once, fan events into the ring buffer
 * + every live `shell.events()` stream emitter for this client. Installed
 * at clientId creation (HTTP bootstrap for web, desktop authority creation
 * for desktop) and lives until the client is evicted.
 */
function installAuthoritySubscriber(clientId: string) {
  const authority = resolveAuthorityForClient(clientId);
  if (!authority) return;
  const state = clientRegistry.ensure(clientId);
  if (state.unsubscribeAuthoritySub) return;
  const unsub = authority.subscribe((event) => {
    if (!scopeMatches(event, clientId)) return;
    if (!isEventAllowedForClient(webModeAuthorizer, clientId, event)) return;
    clientRegistry.recordEvent(clientId, event);
  });
  clientRegistry.setAuthoritySubscriber(clientId, unsub);
}

/**
 * Bind a connected transport (desktop preload or web ws client) to its
 * client. Cancels any pending grace timer. The authority subscriber stays
 * installed across disconnects so the buffer keeps filling for replay.
 */
function bindClientTransport(clientId: string, viewId: number, connection: Connection) {
  installAuthoritySubscriber(clientId);
  clientRegistry.attachLive(clientId, viewId);
  viewIdToClientId.set(viewId, clientId);

  const previousConnection = clientIdToConnection.get(clientId);
  if (previousConnection && previousConnection !== connection) {
    // Reconnect (cookie continuity, tab reuse): drop extension server
    // instances pinned to the old connection before wiring the new one.
    detachAllPanesForClient(clientId);
  }
  clientIdToConnection.set(clientId, connection);
  retroattachAllPanesForClient(clientId);
}

/**
 * Web-mode client binding: validate the client's `lastAppliedSeq` against
 * the ring buffer. Returns `"rebootstrap-required"` if the buffer rolled
 * past — the client drops local state and re-POSTs `/api/shell/bootstrap`.
 * Renderer replays missed events via the `shell.events()` stream (drains
 * buffer on open) rather than through a separate replay channel.
 */
function bindWebClient(
  viewId: number,
  binding: { clientId: string; lastAppliedSeq: number },
  connection: Connection
): "rebootstrap-required" | void {
  const replay = clientRegistry.replayAfter(binding.clientId, binding.lastAppliedSeq);
  if (replay === null) {
    clientRegistry.evict(binding.clientId);
    clientIdToUserId.delete(binding.clientId);
    return "rebootstrap-required";
  }
  bindClientTransport(binding.clientId, viewId, connection);
}

function mintWebClientId(): string {
  return `web_${crypto.randomUUID()}`;
}

/** Main-side session-save debounce. Per-authority — each user in web
 * mode debounces independently; desktop debounces its single authority.
 * Web authorities with no `persistSession` method (no sessionStore wired)
 * silently drop the push. */
const SESSION_SAVE_DEBOUNCE_MS = 250;
type PersistingAuthority = ShellAuthority & {
  persistSession(layouts: FlmuxSessionSaveLayouts): Promise<void>;
};
const pendingLayoutsByAuthority = new WeakMap<PersistingAuthority, FlmuxSessionSaveLayouts>();
const debounceTimerByAuthority = new WeakMap<PersistingAuthority, ReturnType<typeof setTimeout>>();

function pushLayoutForViewId(viewId: number, layouts: FlmuxSessionSaveLayouts) {
  const authority = resolveAuthorityForViewId(viewId);
  if (!authority?.persistSession) return;
  const persisting = authority as PersistingAuthority;
  // Coalescing shape: overwrite pendingLayouts + early-return keeps the
  // already-armed timer; the latest layout wins when it fires. A burst of
  // pushes inside the debounce window writes once.
  pendingLayoutsByAuthority.set(persisting, layouts);
  if (debounceTimerByAuthority.has(persisting)) return;
  const timer = setTimeout(() => {
    debounceTimerByAuthority.delete(persisting);
    const toWrite = pendingLayoutsByAuthority.get(persisting);
    pendingLayoutsByAuthority.delete(persisting);
    if (!toWrite) return;
    void persisting.persistSession(toWrite).catch((error) => {
      console.warn("[flmux] failed to persist session layouts", error);
    });
  }, SESSION_SAVE_DEBOUNCE_MS);
  debounceTimerByAuthority.set(persisting, timer);
}

function releaseView(viewId: number) {
  const clientId = viewIdToClientId.get(viewId);
  viewIdToConnection.delete(viewId);
  if (clientId) {
    viewIdToClientId.delete(viewId);
    // Skip teardown if clientId was rebound to a newer viewId
    // (refresh-before-close lands new register before stale close fires).
    const current = clientRegistry.get(clientId);
    if (current && current.viewId !== null && current.viewId !== viewId) {
      clientRegistry.detachRenderer(viewId);
      return;
    }
    // Tear down extension server instances for this client immediately —
    // connection is gone, server-side state must release before the
    // registry's grace eviction fires.
    detachAllPanesForClient(clientId);
    clientRegistry.markDisconnected(clientId, (state) => {
      // Order matters: read userId, delete the entry, THEN schedule.
      // maybeScheduleAuthorityEviction → countUserClients reads the
      // same map and relies on the entry being gone to count zero.
      const userId = clientIdToUserId.get(state.clientId);
      clientIdToUserId.delete(state.clientId);
      console.log(`[flmux] client ${state.clientId} evicted after grace period`);
      if (userId) maybeScheduleAuthorityEviction(userId);
    });
  }
  // paneEmitters self-clean via stream abort when the underlying
  // connection closes; nothing else to wipe here.
  clientRegistry.detachRenderer(viewId);
}

async function resolveShellModelRouterForRequest(
  context: FlmuxAuthorizationContext | null
): Promise<FlmuxShellModelRouter> {
  if (desktopAuthority) return desktopAuthority.router;
  if (!userAuthorityRegistry) {
    throw new Error("No authority registry configured");
  }
  if (!context) {
    // Web mode always runs with an authorizer — if auth passed, context
    // must be non-null. Guard here for shape safety.
    throw new Error("resolveShellModelRouter: web mode requires an auth context");
  }
  const authority = await userAuthorityRegistry.getOrCreate(context.user.name);
  return authority.router;
}

let desktopViewId: number | null = null;

function requireDesktopViewId() {
  if (desktopViewId == null) {
    throw new Error("Desktop renderer is not attached");
  }
  return desktopViewId;
}

const desktopAuthorityClientId = desktopAuthority?.clientId ?? null;

const resolveShellModel = (viewId: number, hints?: { clientId?: string }): ShellModelAPI | null => {
  return resolveAuthorityForViewId(viewId, hints)?.shellModel ?? null;
};

const resolveShellModelRouter = (viewId: number, hints?: { clientId?: string }): FlmuxShellModelRouter | null => {
  return resolveAuthorityForViewId(viewId, hints)?.router ?? null;
};

function buildShellConfig() {
  return {
    mode: runtimeMode,
    appOrigin: serverOrigin,
    projectDir,
    authorityClientId: desktopAuthorityClientId,
    localExtensions: createLocalExtensionLoadEntries(localExtensions, serverOrigin),
    devMode: process.env.FLMUX_DEV_MODE === "1"
  };
}

function setupConnection(conn: Connection, viewId: number, mode: "desktop" | "web") {
  viewIdToConnection.set(viewId, conn);
  conn.serve(
    shellCap,
    createShellImpl({
      viewId,
      getClientId: () => viewIdToClientId.get(viewId) ?? null,
      paneEmitters,
      resolveShellModel: (hints) => resolveAuthorityForViewId(viewId, hints)?.shellModel ?? null,
      resolveShellModelRouter: (hints) => resolveAuthorityForViewId(viewId, hints)?.router ?? null,
      canSubscribeTerminalForPane: (paneId) => {
        const callerAuthority = resolveAuthorityForViewId(viewId);
        if (!callerAuthority) return false;
        const paneAuthority = paneIdToAuthority.get(paneId);
        return paneAuthority === callerAuthority;
      },
      buildConfig: buildShellConfig,
      desktopAuthority,
      onClientRegister: (binding) => {
        if (mode === "desktop") {
          // Desktop CEF is a single client; viewId binds to the stable
          // "local" identity. Web clients always pass a binding.
          bindClientTransport(DESKTOP_CLIENT_ID, viewId, conn);
          return;
        }
        if (!binding) {
          throw new Error(
            "shell.registerClient: web clients must pass {clientId, lastAppliedSeq} " +
              "obtained from /api/shell/bootstrap"
          );
        }
        return bindWebClient(viewId, binding, conn);
      },
      subscribeShellEvents: (clientId, sinceSeq, emit) => {
        // Atomic drain + subscribe: bunite stream emit is sync, and
        // recordEvent fans buffer→emitters within the same JS tick, so
        // there's no race window between snapshot and live registration.
        const replay = clientRegistry.replayAfter(clientId, sinceSeq);
        if (replay !== null) for (const event of replay) emit(event);
        return clientRegistry.subscribeLive(clientId, emit);
      },
      pushLayout: (layouts) => pushLayoutForViewId(viewId, layouts)
    })
  );
}

let nextWebViewId = 1_000_000;

const portResolution = resolveFlmuxServerPort({
  configFile: flmuxPaths.appConfigFile
});

const server = startFlmuxServer({
  rendererDir,
  resolveShellModelRouter: resolveShellModelRouterForRequest,
  localExtensions,
  port: portResolution.port,
  saveSession: desktopAuthority
    ? (_context, layouts) => desktopAuthority.persistSession(layouts)
    : userAuthorityRegistry
      ? async (context, layouts) => {
          if (!context) {
            throw new Error("/api/session/save: web mode requires an auth context");
          }
          const authority = await userAuthorityRegistry.getOrCreate(context.user.name);
          if (!authority.persistSession) return;
          await authority.persistSession(layouts);
        }
      : undefined,
  // Web-mode HTTP bootstrap. Resolves the calling user from auth context,
  // lazily creates the user's authority, mints a fresh clientId,
  // records the clientId→userId mapping so WS register + shellModel
  // calls route to the right authority, installs the buffer subscriber
  // BEFORE composing the snapshot (so events emitted by shellBootstrap or
  // concurrent callers land in the buffer), and arms the unbound-grace
  // timer so an client whose WS register never arrives doesn't leak
  // a permanent shellCore subscriber.
  bootstrapClient: userAuthorityRegistry
    ? async (context, existingClientId) => {
        if (!context) {
          throw new Error("/api/shell/bootstrap: web mode requires an auth context");
        }
        const userId = context.user.name;
        const authority = await userAuthorityRegistry.getOrCreate(userId);
        // Cookie continuity (B2 Phase 3): reuse the clientId when the
        // browser's cookie matches a still-unbound client owned by this
        // user. Preserves slot state (active ws/pane) across tab refresh
        // inside the 30-second grace window. A still-live client (viewId
        // set — e.g. multi-tab in same browser, or refresh-before-close)
        // mints fresh: re-arming a live client would either tear the live
        // WS down or throw; both are wrong here.
        const existing =
          existingClientId && clientIdToUserId.get(existingClientId) === userId
            ? clientRegistry.get(existingClientId)
            : undefined;
        const canReuse = existing !== undefined && existing.viewId === null;
        const clientId = canReuse ? existingClientId! : mintWebClientId();
        if (!canReuse) {
          clientIdToUserId.set(clientId, userId);
          installAuthoritySubscriber(clientId);
        }
        clientRegistry.armGraceTimer(clientId, (state) => {
          // Same read→delete→schedule ordering as releaseView's onEvict.
          const ownerId = clientIdToUserId.get(state.clientId);
          clientIdToUserId.delete(state.clientId);
          console.log(`[flmux] client ${state.clientId} evicted after grace`);
          if (ownerId) maybeScheduleAuthorityEviction(ownerId);
        });
        // User came back (either fresh or via cookie reuse) — cancel any
        // pending authority eviction scheduled by the previous last-
        // client-gone event.
        cancelPendingAuthorityEviction(userId);
        return authority.shellBootstrap(clientId);
      }
    : undefined,
  authorizer: webModeAuthorizer ?? undefined,
  onRpcConnection:
    runtimeMode === "web"
      ? (conn) => {
          const viewId = nextWebViewId++;
          conn.onClose(() => releaseView(viewId));
          setupConnection(conn, viewId, "web");
        }
      : undefined
});
serverOrigin = server.origin;
// FLMUX_ORIGIN parity: only known after server.listen, so set on env now —
// child processes spawned by extensions can reach the same server without
// passing --origin.
process.env.FLMUX_ORIGIN = serverOrigin;
if (desktopAuthority) {
  // Subscribe BEFORE start() so any pane.added emitted during session
  // restore indexes correctly for terminal routing.
  trackPaneLifecycle(desktopAuthority);
  await desktopAuthority.start(server.origin);
}

console.log(
  `[flmux] ${runtimeMode} mode server listening at ${server.origin}` +
    (portResolution.source !== "default" ? ` (port from ${portResolution.source})` : "")
);
if (webModeAuthPaths) {
  console.log(`[flmux] auth dir: ${webModeAuthPaths.authDir}`);
  console.log(`[flmux] web origin: ${server.origin} (append ?token=<issued-token> on first attach)`);
  console.log(
    `[flmux] issue tokens via: bun src/cli.ts tokens issue --user <name> --auth-dir ${webModeAuthPaths.authDir}`
  );
}

terminalService.subscribe((event: TerminalRuntimeEvent) => {
  // paneId→authority index replaces the O(n_users) fan-out. Events for
  // unknown panes (no paneId or no index entry) are skipped — the
  // shellCore-side applyTerminalEvent would have no-op'd anyway, and
  // enforced routing beats the old probabilistic paneId-uniqueness
  // argument (two authorities can't both accept the same event).
  if (event.paneId) {
    paneIdToAuthority.get(event.paneId)?.applyTerminalEvent(event);
  }
  forwardTerminalEventToSubscribers({ event, paneEmitters });
});

async function stopRuntime() {
  // Graceful shutdown is the user's explicit "I'm done" — also tell the
  // install-scoped daemon to stop. The tmux-style "daemon survives to
  // adopt on next launch" invariant covers crash/SIGKILL paths that
  // bypass this handler, not deliberate Ctrl+C. See internal notes
  try {
    const lock = await new PtydLockFile(flmuxPaths.rootDir).load();
    if (lock) {
      await callJsonRpcIpc(lock.controlIpcPath, "daemon.stop", undefined, 2_000);
    }
  } catch {
    /* best-effort */
  }
  terminalService.dispose?.();
  server.stop();
}

if (runtimeMode === "desktop" && app) {
  const win = new BrowserWindow({
    title: `flmux skeleton v${app.version} - ${app.engineName ?? "engine"} ${app.engineVersion ?? "unknown"}`,
    frame: { x: 80, y: 80, width: 1280, height: 860 },
    url: server.origin,
    titleBarStyle: "default",
    hidden: hiddenWindow,
    preloadOrigins: [server.origin],
    serve: (conn) => {
      // `serve` may run synchronously inside BrowserWindow's constructor —
      // `win.webviewId` isn't assigned yet at that point. Defer to the next
      // microtask so the post-constructor assignment lands first.
      queueMicrotask(() => {
        const viewId = win.webviewId;
        desktopViewId = viewId;
        conn.onClose(() => releaseView(viewId));
        setupConnection(conn, viewId, "desktop");
      });
    }
  });

  win.on("close", () => {
    releaseView(win.webviewId);
    void stopRuntime();
  });
  app.run();
} else {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, async () => {
      await stopRuntime();
      process.exit(0);
    });
  }
  // Bun.serve (invoked by `startFlmuxServer`) owns the event loop in
  // web mode — no native runtime needed.
}
