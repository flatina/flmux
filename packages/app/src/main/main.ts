import { existsSync, mkdirSync } from "node:fs";
import { delimiter, dirname, resolve, sep } from "node:path";
import {
  BrowserWindow,
  AppRuntime,
  defineBunRpc,
  createRpcTransportDemuxer,
  createWebSocketTransport,
  type RpcTransportDemuxer,
  type WebSocketLike
} from "bunite-core";
import type { SequencedShellCoreEvent, ShellModelAPI } from "@flmux/core/shell";
import type { FlmuxRendererBridgeSchema, FlmuxSessionSaveLayouts } from "../shared/rendererBridge";
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
import { createFlmuxHostRequestHandlers } from "./hostRequests";
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
import { discoverConfiguredLocalExtensions, resolveConfiguredLocalExtensionsRootDir } from "./localExtensions";
import type {
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
    ? new AppRuntime({
        logLevel: "info",
        userDataDir: flmuxPaths.cefUserDataDir,
        cefDir: resolve(installRoot, "dist/cef")
      })
    : null;
if (app) await app.ready;

const clientGraceEnvMs = Number.parseInt(process.env.FLMUX_CLIENT_GRACE_MS ?? "", 10);
const clientRegistry = new ClientRegistry(
  Number.isFinite(clientGraceEnvMs) && clientGraceEnvMs > 0 ? { graceMs: clientGraceEnvMs } : undefined
);
const terminalService = createTerminalService();
const sessionStore = runtimeMode === "desktop" ? createSessionStore({ filePath: flmuxPaths.desktopSessionFile }) : null;
// paneId → set of subscribed viewIds. Terminal events fan out to every
// live subscriber so multiple tabs of the same user can share a pane
// (device handoff: desktop tab stays open while mobile attaches).
// Disconnected viewIds are swept by `releaseView`; stale entries that
// slip through are lazily skipped by the forwarder.
const paneSubscribers = new Map<string, Set<number>>();
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

// (paneId × clientId) → server instance, plus the pane→kind & client→demux
// indexes used to drive attach/detach in pane and client lifecycles.
const paneServerInstances = new Map<string, ExtensionServerPaneInstance>();
const paneKinds = new Map<string, string>();
const clientIdToDemux = new Map<string, RpcTransportDemuxer>();
const webViewIdToDemux = new Map<number, RpcTransportDemuxer>();

function findExtensionIdForPaneKind(kind: string): string | undefined {
  return localExtensions.find((ext) => ext.runtimeManifest.panes?.some((p) => p.kind === kind))?.id;
}

function paneInstanceKey(extId: string, paneId: string, clientId: string) {
  return `${extId}::${paneId}::${clientId}`;
}

/**
 * ACL-aware ShellClient for an extension server entry. Calls route through
 * the same `allow_paths` + `allow_pane_kinds` gates as HTTP. Desktop
 * (no authorizer) grants through, same as preload/WS trust.
 *
 * Returns null when the pane→authority mapping isn't established yet
 * (racing `clientIdToDemux` writes); caller warns and retries.
 */
function createExtensionShellClient(paneId: string, clientId: string): ShellClientImport | null {
  const authority = paneIdToAuthority.get(paneId);
  if (!authority) return null;
  const shellModel = authority.shellModel;
  const authorizer = webModeAuthorizer;
  const caller = { clientId, sourcePaneId: paneId };

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

async function attachExtensionServerChannel(paneId: string, kind: string, clientId: string) {
  const extId = findExtensionIdForPaneKind(kind);
  if (!extId) return;
  // Await before fetching server: init failure deletes the entry.
  const initPromise = extensionServerInits.get(extId);
  if (initPromise) await initPromise;
  const server = extensionServers.get(extId);
  if (!server?.onPaneConnected) return;
  const demux = clientIdToDemux.get(clientId);
  if (!demux) return;
  const shell = createExtensionShellClient(paneId, clientId);
  if (!shell) {
    console.warn(
      `[flmux] extension '${extId}' skipped onPaneConnected — no authority mapped for pane '${paneId}' (client ${clientId})`
    );
    return;
  }
  const key = paneInstanceKey(extId, paneId, clientId);
  if (paneServerInstances.has(key)) return;
  const dataDir = resolveExtensionDataDir(extId);
  if (!dataDir) {
    // extId came from `findExtensionIdForPaneKind` so this is unreachable
    // today, but fail closed if discovery ever becomes dynamic — extensions
    // expect dataDir to be a string.
    console.warn(`[flmux] extension '${extId}' skipped onPaneConnected — data dir not provisioned`);
    return;
  }
  try {
    const rpcChannel = demux.channel(paneId);
    const inst = await server.onPaneConnected(paneId, clientId, { rpcChannel, shell, dataDir });
    if (inst) paneServerInstances.set(key, inst);
  } catch (err) {
    console.warn(`[flmux] extension '${extId}' onPaneConnected error (pane ${paneId}, client ${clientId}):`, err);
  }
}

function detachExtensionServerChannel(paneId: string, kind: string, clientId: string) {
  const extId = findExtensionIdForPaneKind(kind);
  if (!extId) return;
  const key = paneInstanceKey(extId, paneId, clientId);
  const inst = paneServerInstances.get(key);
  if (!inst) return;
  try {
    inst.dispose?.();
  } catch (err) {
    console.warn(`[flmux] extension '${extId}' dispose error (pane ${paneId}, client ${clientId}):`, err);
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
      for (const [clientId] of clientIdToDemux) {
        if (resolveAuthorityForClient(clientId) === authority) {
          attachExtensionServerChannel(paneId, snapshot.kind, clientId);
        }
      }
    } else if (event.topic === "pane.removed") {
      const { paneId } = event.payload;
      paneIdToAuthority.delete(paneId);
      const kind = paneKinds.get(paneId);
      if (kind) {
        for (const [clientId] of clientIdToDemux) {
          detachExtensionServerChannel(paneId, kind, clientId);
        }
        paneKinds.delete(paneId);
      }
    }
  });
  paneLifecycleUnsubs.set(authority, unsub);
  return unsub;
}

// After an client's demux is installed, retroactively attach every pane
// already bound to that client's authority. Used at:
//   - desktop boot (demux created after session restore panes land)
//   - web client bind (demux was created at WS open, clientId at register)
function retroattachAllPanesForClient(clientId: string) {
  const authority = resolveAuthorityForClient(clientId);
  if (!authority) return;
  for (const [paneId, kind] of paneKinds) {
    if (paneIdToAuthority.get(paneId) === authority) {
      attachExtensionServerChannel(paneId, kind, clientId);
    }
  }
}

function detachAllPanesForClient(clientId: string) {
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
  clientIdToDemux.delete(clientId);
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
function ensureBufferSubscriber(clientId: string) {
  const authority = resolveAuthorityForClient(clientId);
  if (!authority) return;
  const state = clientRegistry.ensure(clientId);
  if (state.unsubscribeBuffer) return;
  const unsub = authority.subscribe((event) => {
    if (!scopeMatches(event, clientId)) return;
    if (!isEventAllowedForClient(webModeAuthorizer, clientId, event)) return;
    clientRegistry.pushBuffered(clientId, event);
  });
  clientRegistry.setBufferSubscriber(clientId, unsub);
}

/**
 * Bind a connected transport (desktop preload or web ws client) to an
 * client's live event forwarder. The buffer subscriber is installed
 * separately via `ensureBufferSubscriber` at client creation. On
 * reconnect this is called again — the live forwarder is replaced, the
 * buffer subscriber is untouched.
 */
function installClientForwarder(clientId: string, viewId: number) {
  const authority = resolveAuthorityForClient(clientId);
  if (!authority) return;
  const client = clientRegistry.resolveByViewId(viewId);
  if (!client) return;

  ensureBufferSubscriber(clientId);

  const unsubLive = authority.subscribe((event) => {
    if (!scopeMatches(event, clientId)) return;
    if (!isEventAllowedForClient(webModeAuthorizer, clientId, event)) return;
    client.bridge?.sendProxy["shellCore.event"](event);
  });
  clientRegistry.attachLive(clientId, viewId, unsubLive);
  viewIdToClientId.set(viewId, clientId);
}

/**
 * Web-mode client binding: replay any buffered events the client missed
 * between bootstrap and register, then install the live forwarder. Returns
 * `"rebootstrap-required"` when the client's `lastAppliedSeq` is older than
 * the ring buffer's oldest seq — the client drops local state and re-POSTs
 * `/api/shell/bootstrap`.
 */
function bindWebClient(
  viewId: number,
  binding: { clientId: string; lastAppliedSeq: number }
): "rebootstrap-required" | void {
  const replayed = clientRegistry.replayAfter(binding.clientId, binding.lastAppliedSeq);
  if (replayed === null) {
    // Buffer rolled past the client's seq — the stale client entry is
    // useless now; the client will mint a fresh id on re-bootstrap. Drop
    // the clientId→user mapping too so the entry doesn't linger.
    clientRegistry.evict(binding.clientId);
    clientIdToUserId.delete(binding.clientId);
    return "rebootstrap-required";
  }
  const client = clientRegistry.resolveRendererByViewId(viewId);
  if (client) {
    for (const event of replayed) {
      client.bridge.sendProxy["shellCore.event"](event);
    }
  }
  installClientForwarder(binding.clientId, viewId);

  // Tie the WS demux (stored at open-time under viewId) to the now-known
  // clientId, then open channels for every pane the client's
  // authority already owns. If the clientId is being rebound to a fresh
  // socket (grace-period reconnect, tab reuse), drop every server instance
  // still pinned to the old demux first — otherwise it stays bound to the
  // dead transport and the eventual old-socket `close` would tear down the
  // new binding via `detachAllPanesForClient`.
  const demux = webViewIdToDemux.get(viewId);
  if (demux) {
    const previousDemux = clientIdToDemux.get(binding.clientId);
    if (previousDemux && previousDemux !== demux) {
      detachAllPanesForClient(binding.clientId);
    }
    clientIdToDemux.set(binding.clientId, demux);
    retroattachAllPanesForClient(binding.clientId);
  }
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
  webViewIdToDemux.delete(viewId);
  if (clientId) {
    viewIdToClientId.delete(viewId);
    // Skip teardown if clientId was rebound to a newer viewId
    // (refresh-before-close lands new register before stale close fires).
    const current = clientRegistry.get(clientId);
    if (current && current.viewId !== null && current.viewId !== viewId) {
      clientRegistry.detachRenderer(viewId);
      for (const [paneId, subscribers] of paneSubscribers.entries()) {
        if (subscribers.delete(viewId) && subscribers.size === 0) {
          paneSubscribers.delete(paneId);
        }
      }
      return;
    }
    // Tear down extension channels for this client immediately —
    // connection is gone, server-side rpcs must release their pane state
    // before the registry's grace eviction fires.
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
  for (const [paneId, subscribers] of paneSubscribers.entries()) {
    if (subscribers.delete(viewId) && subscribers.size === 0) {
      paneSubscribers.delete(paneId);
    }
  }
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

const rendererRpc = defineBunRpc<FlmuxRendererBridgeSchema>({
  handlers: {
    requests: createFlmuxHostRequestHandlers({
      mode: runtimeMode,
      getAppOrigin: () => serverOrigin,
      getProjectDir: () => projectDir,
      getAuthorityClientId: () => desktopAuthorityClientId,
      getCallerViewId: requireDesktopViewId,
      getCallerClientId: (viewId) => viewIdToClientId.get(viewId) ?? null,
      paneSubscribers,
      resolveShellModel,
      resolveShellModelRouter,
      localExtensions,
      desktopAuthority,
      onClientRegister: (viewId) => {
        // Desktop CEF is a single client; its viewId binds to the
        // stable "local" identity for the life of the process. Web clients
        // reach the separate handler below with a `binding` arg — the
        // desktop preload never passes one.
        installClientForwarder(DESKTOP_CLIENT_ID, viewId);
      },
      pushLayout: pushLayoutForViewId
    })
  }
});

// Web RPC handler — per-connection assembles (ws pipe → demuxer → rpc on
// "default" channel). demux is retained on each client so extension panes
// can later mint their own channels off the same connection.
type WebClient = {
  ws: WebSocketLike;
  rpc: ReturnType<typeof defineBunRpc<FlmuxRendererBridgeSchema>>;
  demux: RpcTransportDemuxer;
};

const webConnections = new Map<
  WebSocketLike,
  { client: WebClient; receive: (raw: ArrayBuffer | Uint8Array) => void }
>();

const rendererWebHandler = {
  open(ws: WebSocketLike) {
    const pipe = createWebSocketTransport(ws);
    const demux = createRpcTransportDemuxer(pipe.transport);
    const rpc = defineBunRpc<FlmuxRendererBridgeSchema>({ handlers: {} });
    // Fire-and-forget: the WS pipe is already up; the HELLO handshake
    // resolves once the renderer binds its own side of the channel.
    // Nothing on the server path needs to wait for that resolution —
    // per-connection rpc is receive-side and main doesn't kick off
    // requests before the browser registers its handler.
    void demux.channel("default").bindTo(rpc);
    const client: WebClient = { ws, rpc, demux };
    webConnections.set(ws, { client, receive: pipe.receive });
    rendererWebHandler.onWebClientConnected?.(client);
  },
  message(ws: WebSocketLike, raw: string | Buffer | ArrayBuffer | Uint8Array) {
    if (typeof raw === "string") return;
    const entry = webConnections.get(ws);
    if (!entry) return;
    entry.receive(raw instanceof Buffer ? new Uint8Array(raw) : raw);
  },
  close(ws: WebSocketLike) {
    const entry = webConnections.get(ws);
    if (!entry) return;
    // onWebClientDisconnected → releaseView → detachAllPanesForClient
    // runs extension server instance dispose() calls which may send final
    // messages through per-pane channels. Those must complete before the
    // default-channel rpc + demuxer tear down, so disconnect first, tear
    // down transports after.
    webConnections.delete(ws);
    rendererWebHandler.onWebClientDisconnected?.(entry.client);
    entry.client.rpc.dispose();
    entry.client.demux.dispose();
  },
  onWebClientConnected: undefined as ((client: WebClient) => void) | undefined,
  onWebClientDisconnected: undefined as ((client: WebClient) => void) | undefined
};

let nextWebViewId = 1_000_000;
const webViewIds = new WeakMap<WebClient, number>();

rendererWebHandler.onWebClientConnected = (client) => {
  const viewId = nextWebViewId++;
  webViewIds.set(client, viewId);
  webViewIdToDemux.set(viewId, client.demux);
  client.rpc.setRequestHandler(
    createFlmuxHostRequestHandlers({
      mode: runtimeMode,
      getAppOrigin: () => serverOrigin,
      getProjectDir: () => projectDir,
      // Web clients discover their *own* authority's clientId via
      // /api/clients — this field is historically the "well-known authority
      // clientId" for the preload-RPC transport. In web mode the value is
      // user-specific and not known at WS-open time, so we expose null and
      // let the browser read it through the auth-scoped /api/clients route.
      getAuthorityClientId: () => null,
      getCallerViewId: () => viewId,
      getCallerClientId: (id) => viewIdToClientId.get(id) ?? null,
      paneSubscribers,
      resolveShellModel,
      resolveShellModelRouter,
      localExtensions,
      desktopAuthority,
      onClientRegister: (registeredViewId, binding) => {
        if (!binding) {
          throw new Error(
            "flmux.client.register: web clients must pass {clientId, lastAppliedSeq} " +
              "obtained from /api/shell/bootstrap"
          );
        }
        return bindWebClient(registeredViewId, binding);
      },
      // Per-user sessionStore persistence (B2 Phase 2): the user's
      // authority owns its own store at `<authDir>/sessions/<userId>/session.json`
      // — main resolves the right one from the caller's viewId.
      pushLayout: pushLayoutForViewId
    })
  );
  clientRegistry.attachRenderer(viewId, client.rpc);
};

rendererWebHandler.onWebClientDisconnected = (client) => {
  const viewId = webViewIds.get(client);
  if (viewId == null) return;
  releaseView(viewId);
};

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
          ensureBufferSubscriber(clientId);
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
  rpcWebHandler: rendererWebHandler
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
  forwardTerminalEventToSubscribers({
    event,
    paneSubscribers,
    clientRegistry
  });
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
    title: `flmux skeleton v${app.version} - CEF ${app.cefVersion ?? "unknown"}`,
    frame: { x: 80, y: 80, width: 1280, height: 860 },
    url: server.origin,
    titleBarStyle: "default",
    hidden: hiddenWindow,
    preloadOrigins: [server.origin]
  });

  // Wrap the preload pipe in a demuxer so the "default" channel carries
  // ShellModelAPI and extension channels can mount alongside (one channel
  // per extension pane, keyed by paneId).
  const desktopDemux = createRpcTransportDemuxer(win.view.transport);
  // Fire-and-forget bindTo — the CEF renderer comes up later and its
  // `defineWebviewRpc(...).bindTo(...)` call completes the handshake.
  void desktopDemux.channel("default").bindTo(rendererRpc);
  clientIdToDemux.set(DESKTOP_CLIENT_ID, desktopDemux);
  // Session-restored panes fire pane.added before this point — pick them up.
  retroattachAllPanesForClient(DESKTOP_CLIENT_ID);

  desktopViewId = win.webviewId;
  clientRegistry.attachRenderer(win.webviewId, rendererRpc);

  win.on("close", () => {
    releaseView(win.webviewId);
    // Fire-and-forget: CEF native teardown keeps the process alive long
    // enough for the daemon-stop IPC (typically <100ms) to complete.
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
