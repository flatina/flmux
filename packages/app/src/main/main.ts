import { mkdirSync, realpathSync } from "node:fs";
import { delimiter, resolve, sep } from "node:path";
import {
  BrowserWindow,
  AppRuntime,
  acquireSingleInstanceLock
} from "bunite-core";
import type { Connection } from "bunite-core/rpc";
import type { PathCallerContext, SequencedShellCoreEvent, ShellModelAPI } from "@flmux/core/shell";
import { ModelPathError } from "@flmux/core/shell";
import { flmuxBridgeCap, type FlmuxRendererBootstrapConfig, type FlmuxSessionSaveLayouts } from "../shared/rendererBridge";
import { resolveWorkspaceTabstripMode } from "../shared/workspaceTabstrip";
import { createSessionImpl } from "./sessionImpl";
import { createBridgeImpl, type MintedSession } from "./bridgeImpl";
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
import { createWebauthnAuthService } from "./auth/webauthnService";
import type { FlmuxUser as FlmuxUserImport } from "./auth/userStore";
import { eventToReadPath } from "./auth/eventAclPath";
import { createFsPolicyResolver } from "./auth/fsPolicy";
import { generateToken } from "./auth/tokenFormat";
import type { ExtensionFsPolicy } from "@flmux/extension-api";
import { resolveFlmuxServerPort } from "./auth/serverConfig";
import { resolveFlmuxAppTitle, resolveFlmuxAppName } from "./appConfig";
import { resolveFlmuxRuntimeMode } from "./runtimeMode";
import { resolveFlmuxRootDir, resolveFlmuxPaths, resolveInstallLayout } from "./flmuxPaths";
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
  ExtensionServerDefinition,
  ExtensionServerPaneInstance,
  ShellClient as ShellClientImport
} from "@flmux/extension-api";
import type { CapDef, ImplOf, ServeHandle } from "bunite-core/rpc";

type ShellAuthority = Pick<
  DesktopShellAuthority | WebModeShellAuthority,
  "subscribe" | "applyTerminalEvent" | "shellBootstrap" | "browserController"
> & {
  readonly shellModel: ShellModelAPI;
  readonly router: FlmuxShellModelRouter;
  readonly clientId: string;
  persistSession?(layouts: FlmuxSessionSaveLayouts): Promise<void>;
};

const runtimeMode = resolveFlmuxRuntimeMode();
const devAuthAs = readDevAuthAsFlag(Bun.argv);
// `--dev-auth-as` fabricates an all-permissive user for every request — it must
// never activate on a public deployment. Honor it only in explicit dev mode
// (`--dev` flag or preset `FLMUX_DEV_MODE=1`); fail closed otherwise so a stray
// flag in production refuses to boot rather than silently opening the door.
const devModeRequested = process.env.FLMUX_DEV_MODE === "1" || Bun.argv.includes("--dev");
if (devAuthAs && !devModeRequested) {
  console.error("[flmux] FATAL: --dev-auth-as requires dev mode (--dev or FLMUX_DEV_MODE=1); refusing to start.");
  process.exit(1);
}
process.env.BUNITE_REMOTE_DEBUGGING_PORT ??= "9227";
process.env.FLMUX_DEV_MODE ??= devModeRequested ? "1" : "";
const hiddenWindow = process.env.FLMUX_HIDDEN_WINDOW === "1";

function parseOptionalPort(value: string | undefined): number | undefined {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : undefined;
}

function prependFlmuxBinToPath(binDir: string): void {
  // Reuse existing PATH casing on Windows; blind assignment creates a sibling entry.
  const existingKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH");
  const key = existingKey ?? "PATH";
  const current = existingKey ? process.env[existingKey] : undefined;
  process.env[key] = current ? `${binDir}${delimiter}${current}` : binDir;
}

function readDevAuthAsFlag(argv: readonly string[]): string | undefined {
  const i = argv.indexOf("--dev-auth-as");
  if (i < 0 || i + 1 >= argv.length) return undefined;
  const value = argv[i + 1]?.trim();
  // Reject next flag — `--dev-auth-as --web` would silently bypass as user "--web".
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

// Deploy vs dev layout (compiled exe dir vs repo root). NOT existsSync(baseDir/
// renderer): in dev the source `src/renderer` sits next to baseDir and
// false-positives → serves un-transpiled `/main.ts` (rejected → blank).
const { isDeployLayout, baseDir, installRoot } = resolveInstallLayout();
const rendererDir = isDeployLayout ? resolve(baseDir, "renderer") : resolve(baseDir, "../dist/renderer");
const flmuxPaths = resolveFlmuxPaths(resolveFlmuxRootDir(installRoot));
const projectDir = flmuxPaths.rootDir;
const defaultExtensionsRoot = isDeployLayout ? resolve(baseDir, "extensions") : resolve(baseDir, "../../../extensions");
const localExtensionsRootDir = resolveConfiguredLocalExtensionsRootDir(defaultExtensionsRoot);

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

// CEF needs userDataDir to exist before boot (boot path: `new AppRuntime`).
if (runtimeMode === "desktop") {
  mkdirSync(flmuxPaths.cefUserDataDir, { recursive: true });
}

// `.flmux/bin/flmux{,.cmd}` — terminal-pane PATH shim for this install's CLI.
const shimResult = ensureFlmuxCliShim({ binDir: flmuxPaths.binDir, baseDir });
if (!shimResult.ok) {
  console.warn(`[flmux] cli shim skipped (${shimResult.reason})`);
}

// Mirror terminal-pane env into flmux process so spawned extension servers inherit it.
process.env.FLMUX_ROOT = flmuxPaths.rootDir;
prependFlmuxBinToPath(flmuxPaths.binDir);
const app =
  runtimeMode === "desktop"
    ? (() => {
        process.env.BUNITE_CEF_DIR ??= resolve(installRoot, "dist/cef");
        return new AppRuntime({
          logLevel: (process.env.BUNITE_LOG_LEVEL as "debug" | "info" | "warn" | "error" | "silent") ?? "info",
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
// paneId → terminalEvents stream emitters. Fan-out for multi-tab same-pane sharing.
const paneEmitters = new Map<string, Set<(event: TerminalRuntimeEvent) => void>>();
const localExtensions = await discoverConfiguredLocalExtensions(localExtensionsRootDir);

const knownExtensionIds = new Set(localExtensions.map((ext) => ext.id));
const provisionedExtensionDirs = new Set<string>();
const fsPolicyResolver = createFsPolicyResolver(flmuxPaths.usersRootDir);
// Backstop TTL for per-session agent API tokens (normally revoked on detach).
const AGENT_API_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const extDataRootResolved = resolve(flmuxPaths.extDataRootDir);
function resolveExtensionDataDir(extensionId: string): string | null {
  if (!knownExtensionIds.has(extensionId)) return null;
  const dir = resolve(flmuxPaths.extDataRootDir, extensionId);
  // Defense in depth: ensure resolved dir stays under extDataRootDir.
  const rootWithSep = extDataRootResolved.endsWith(sep) ? extDataRootResolved : extDataRootResolved + sep;
  if (!dir.startsWith(rootWithSep)) return null;
  if (!provisionedExtensionDirs.has(extensionId)) {
    mkdirSync(dir, { recursive: true });
    provisionedExtensionDirs.add(extensionId);
  }
  return dir;
}

// Per-extension PATH shims (opt-in via manifest `commands[].shim`).
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

// Extension server entries: imported once, registered per (paneId, clientId) subscription.
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

// Per-session ext serve handles + dispose hooks — collected in bindMintedSession,
// torn down by MintedSession.dispose on conn.onClose.
interface SessionExtensionsState {
  serveHandles: ServeHandle[];
  sessionDisposes: Array<() => void>;
}
const sessionExtensionsBySessionId = new Map<string, SessionExtensionsState>();
const paneServerInstances = new Map<string, ExtensionServerPaneInstance>();
const paneKinds = new Map<string, string>();
const clientIdToConnection = new Map<string, Connection>();
const viewIdToConnection = new Map<number, Connection>();

function findExtensionIdForPaneKind(kind: string): string | undefined {
  return localExtensions.find((ext) => ext.runtimeManifest.panes?.some((p) => p.kind === kind))?.id;
}

function paneInstanceKey(extId: string, paneId: string, clientId: string) {
  return `${extId}::${paneId}::${clientId}`;
}

// ACL-aware ShellClient for extension server entries. Desktop grants through.
// Returns null when pane→authority mapping is racing; caller retries.
function createExtensionShellClient(paneId: string | null, sessionId: string): ShellClientImport | null {
  const authority = paneId ? paneIdToAuthority.get(paneId) : resolveAuthorityForClient(sessionId);
  if (!authority) return null;
  const shellModel = authority.shellModel;
  const authorizer = webModeAuthorizer;
  const caller: PathCallerContext = paneId
    ? { slotKey: sessionId, sourcePaneId: paneId }
    : { slotKey: sessionId };

  // Per-call resolve so token revocation drops ACL on the next call.
  function resolveUser(): FlmuxUserImport | null {
    if (!authorizer) return null;
    const userId = clientIdToUserId.get(sessionId);
    if (!userId) return null;
    return authorizer.resolveUserByName(userId);
  }

  function assertAllowed(method: "read" | "write" | "call", path: string) {
    if (!authorizer) return;
    const user = resolveUser();
    if (!user) {
      throw new Error(`No resolvable user for session '${sessionId}' (shell ${method} '${path}')`);
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

// Per-session: fire each extension's onSession + serve returned caps. Impl closure captures identity.
async function attachExtensionsForSession(opts: {
  conn: Connection;
  sessionId: string;
  userId: string;
  authority: ShellAuthority;
}): Promise<SessionExtensionsState> {
  // Resume-on-new-conn: detach old sync so disposes fire on previous Connection.
  const previous = sessionExtensionsBySessionId.get(opts.sessionId);
  if (previous) {
    sessionExtensionsBySessionId.delete(opts.sessionId);
    for (const dispose of previous.sessionDisposes) {
      try { dispose(); } catch (err) {
        console.warn(`[flmux] previous-session dispose error:`, err);
      }
    }
  }
  const state: SessionExtensionsState = { serveHandles: [], sessionDisposes: [] };
  // Per-user fs grant (shared by the session's extensions). Desktop (no
  // authorizer) = unconfined; web resolves per user, absent → fail-closed.
  const fsPolicy: ExtensionFsPolicy = webModeAuthorizer
    ? (() => {
        const u = webModeAuthorizer.getUser(opts.userId);
        return u ? fsPolicyResolver.resolve(u) : { unconfined: false, binds: [] };
      })()
    : { unconfined: true, binds: [] };
  // Per-session machine token for subprocess HTTP callbacks (e.g. the agent's
  // sandboxed CLI). User-scoped, revoked on session detach (state.sessionDisposes),
  // TTL-backstopped against a crash. Web only — desktop has no auth.
  const authz = webModeAuthorizer;
  const mintApiToken = authz
    ? () => {
        const minted = generateToken();
        authz.tokenStore.append({
          id: minted.id,
          user: opts.userId,
          tokenHash: minted.hash,
          tokenPrefix: minted.prefix,
          createdAt: new Date().toISOString(),
          kind: "machine",
          label: `agent-api:${opts.sessionId}`,
          expiresAt: new Date(Date.now() + AGENT_API_TOKEN_TTL_MS).toISOString()
        });
        state.sessionDisposes.push(() => {
          try {
            authz.tokenStore.removeById(minted.id);
          } catch {
            /* best-effort; TTL + startup prune backstops */
          }
        });
        return { origin: serverOrigin, token: minted.value };
      }
    : undefined;
  for (const [extId, def] of extensionServers) {
    if (!def.onSession) continue;
    if (!userCanUseExtension(opts.userId, extId)) continue;
    const initPromise = extensionServerInits.get(extId);
    if (initPromise) await initPromise;
    const dataDir = resolveExtensionDataDir(extId);
    if (!dataDir) continue;
    const shell = createExtensionShellClient(null, opts.sessionId);
    if (!shell) continue;
    try {
      await def.onSession({
        dataDir,
        sessionId: opts.sessionId,
        userId: opts.userId,
        fsPolicy,
        mintApiToken,
        shell,
        serve: <C extends CapDef<any, any>>(cap: C, impl: ImplOf<C>) => {
          state.serveHandles.push(opts.conn.serve(cap, impl));
        },
        bootstrap: <C extends CapDef<any, any>>(cap: C) => opts.conn.bootstrap(cap),
        onDispose: (fn) => {
          state.sessionDisposes.push(fn);
        }
      });
    } catch (err) {
      console.warn(`[flmux] extension '${extId}' onSession error (session ${opts.sessionId}):`, err);
    }
  }
  sessionExtensionsBySessionId.set(opts.sessionId, state);
  return state;
}

function detachExtensionsForSession(sessionId: string, conn: Connection) {
  const state = sessionExtensionsBySessionId.get(sessionId);
  if (!state) return;
  sessionExtensionsBySessionId.delete(sessionId);
  for (const handle of state.serveHandles) {
    try { conn.unserve(handle); } catch { /* swallow */ }
  }
  for (const dispose of state.sessionDisposes) {
    try { dispose(); } catch (err) {
      console.warn(`[flmux] extension session dispose error:`, err);
    }
  }
}

/**
 * Per-pane lifecycle notification. Awaits the (ext × client) bind promise
 * so `onPaneConnected` never sees a half-bound state. Re-checks demux after
 * the await — client disconnect during the bind gates pane attach.
 */
async function attachExtensionServerPane(paneId: string, kind: string, sessionId: string) {
  const extId = findExtensionIdForPaneKind(kind);
  if (!extId) return;
  const server = extensionServers.get(extId);
  if (!server?.onPaneConnected) return;
  const shell = createExtensionShellClient(paneId, sessionId);
  if (!shell) return;
  const dataDir = resolveExtensionDataDir(extId);
  if (!dataDir) return;
  const key = paneInstanceKey(extId, paneId, sessionId);
  if (paneServerInstances.has(key)) return;
  try {
    const inst = await server.onPaneConnected(paneId, sessionId, { shell, dataDir });
    if (!clientIdToConnection.has(sessionId)) {
      try { inst?.dispose?.(); } catch (err) {
        console.warn(`[flmux] ext '${extId}' late pane dispose (pane ${paneId}, session ${sessionId}):`, err);
      }
      return;
    }
    if (inst) paneServerInstances.set(key, inst);
  } catch (err) {
    console.warn(`[flmux] ext '${extId}' onPaneConnected error (pane ${paneId}, session ${sessionId}):`, err);
  }
}

function detachExtensionServerPane(paneId: string, kind: string, sessionId: string) {
  const extId = findExtensionIdForPaneKind(kind);
  if (!extId) return;
  const key = paneInstanceKey(extId, paneId, sessionId);
  const inst = paneServerInstances.get(key);
  if (!inst) return;
  try { inst.dispose?.(); } catch (err) {
    console.warn(`[flmux] ext '${extId}' pane dispose error (pane ${paneId}, session ${sessionId}):`, err);
  }
  paneServerInstances.delete(key);
}
const webModeAuthPaths =
  runtimeMode === "web"
    ? {
        authDir: flmuxPaths.authDir,
        usersFile: flmuxPaths.usersFile,
        tokensFile: flmuxPaths.tokensFile,
        webauthnFile: flmuxPaths.webauthnFile
      }
    : null;
const webModeAuthorizer = webModeAuthPaths ? createFlmuxWebModeAuthorizer(webModeAuthPaths, { devAuthAs }) : null;
// Prune expired session/enrollment tokens off the hot path: once at startup,
// then hourly. authorize()/findByHash never prune (per-request file churn).
if (webModeAuthorizer) {
  webModeAuthorizer.tokenStore.prune();
  const pruneTimer = setInterval(() => webModeAuthorizer.tokenStore.prune(), 60 * 60 * 1000);
  (pruneTimer as { unref?(): void }).unref?.();
}
const webauthnService =
  runtimeMode === "web" && webModeAuthorizer
    ? createWebauthnAuthService({
        authorizer: webModeAuthorizer,
        webauthnFile: flmuxPaths.webauthnFile,
        tokensFile: flmuxPaths.tokensFile,
        publicOrigin: process.env.FLMUX_PUBLIC_ORIGIN
      })
    : null;
if (devAuthAs && runtimeMode === "web") {
  console.warn(`[flmux] [!] DEV AUTH: all web requests authenticated as '${devAuthAs}' — do not use in production`);
} else if (devAuthAs) {
  console.warn(`[flmux] --dev-auth-as has no effect in ${runtimeMode} mode; ignored`);
}

const appName = resolveFlmuxAppName(flmuxPaths.appConfigFile) ?? "flmux";

const desktopAuthority: DesktopShellAuthority | null =
  runtimeMode === "desktop" && sessionStore
    ? await createDesktopShellAuthority({
        projectDir,
        runtimeLabel: "desktop local-http preload ok",
        appVersion: FLMUX_APP_VERSION,
        initialAppTitle: resolveFlmuxAppTitle(flmuxPaths.appConfigFile) ?? appName,
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
        initialAppTitle: resolveFlmuxAppTitle(flmuxPaths.appConfigFile) ?? appName,
        terminalService,
        clientRegistry,
        localExtensions,
        getOrigin: () => serverOrigin,
        onAuthorityCreated: (userId, authority) => {
          trackPaneLifecycle(authority);
          // HTTP probes (/api/clients, /api/model/path/*) lazy-mint an authority
          // without binding a session. Arm grace immediately — bridge.createSession
          // / resumeSession cancel via `cancelPendingAuthorityEviction(userId)`.
          maybeScheduleAuthorityEviction(userId);
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
        sessionsDir: runtimeMode === "web" ? flmuxPaths.webSessionsDir : undefined,
        fsPolicyResolver,
        resolveUserByName: (userId) => webModeAuthorizer?.resolveUserByName(userId) ?? null,
        makePaneKindGuard: (userId) => (kind) => {
          if (!isPaneKindAllowedForUser(userId, kind)) {
            throw new ModelPathError("NOT_CALLABLE", `pane kind '${kind}' is not permitted for user '${userId}'`);
          }
        }
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
const MAX_SESSIONS_PER_USER = Number(process.env.FLMUX_MAX_SESSIONS_PER_USER) || 25;
// Terminal event routing index: paneId → owning authority. Replaces the
// naive fan-out-to-every-authority pattern so terminal events apply to
// exactly the authority that owns the pane, not every authority whose
// ShellCore happens to lack the id. Kept in sync via pane.added /
// pane.removed subscribers installed once per authority (desktop at
// startup, web on first getOrCreate via the registry's onAuthorityCreated
// hook).
const paneIdToAuthority = new Map<string, ShellAuthority>();
// Per-authority unsubs so eviction doesn't leak shellCore subscribers.
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

function retroattachPanesForSession(sessionId: string): void {
  const authority = resolveAuthorityForClient(sessionId);
  if (!authority) return;
  for (const [paneId, kind] of paneKinds) {
    if (paneIdToAuthority.get(paneId) === authority) {
      void attachExtensionServerPane(paneId, kind, sessionId);
    }
  }
}

function detachAllPanesForSession(sessionId: string) {
  const keyPrefix = `::`;
  for (const key of [...paneServerInstances.keys()]) {
    if (!key.endsWith(keyPrefix + sessionId)) continue;
    const inst = paneServerInstances.get(key);
    try { inst?.dispose?.(); } catch (err) {
      console.warn(`[flmux] ext pane dispose error (key ${key}):`, err);
    }
    paneServerInstances.delete(key);
  }
  clientIdToConnection.delete(sessionId);
}

function scopeMatches(event: SequencedShellCoreEvent, clientId: string): boolean {
  if (event.scope === "all") return true;
  return event.targetClientId === clientId;
}

// Per-user pane-kind role gate (web). Resolves the role fresh each call so
// users.toml edits apply without restart. Desktop (no authorizer) = allow.
function isPaneKindAllowedForUser(userId: string, kind: string): boolean {
  if (!webModeAuthorizer) return true;
  const user = webModeAuthorizer.resolveUserByName(userId);
  return user ? webModeAuthorizer.isPaneKindAllowed(user, kind) : false;
}

// An extension's caps are served to a user only if their role can use at least
// one of its pane kinds. Pane-less utility extensions are always available.
function userCanUseExtension(userId: string, extId: string): boolean {
  const ext = localExtensions.find((e) => e.id === extId);
  const kinds = ext?.runtimeManifest.panes?.map((p) => p.kind) ?? [];
  if (kinds.length === 0) return true;
  return kinds.some((k) => isPaneKindAllowedForUser(userId, k));
}

// Broadcast ACL gate: deliver only if user has read on the event's mapped path.
function isEventAllowedForClient(
  authorizer: FlmuxWebModeAuthorizer | null,
  clientId: string,
  event: SequencedShellCoreEvent
): boolean {
  // Fail-open on miss: avoids teardown-race throws in broadcast loop.
  if (!authorizer) return true;
  const userId = clientIdToUserId.get(clientId);
  if (!userId) return true;
  const user = authorizer.getUser(userId);
  if (!user) return true;
  const path = eventToReadPath(event);
  if (path === null) return true;
  return authorizer.isPathAllowed(user, "read", path);
}

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

// Subscribe once per clientId; fan events into ring buffer + live stream emitters. Idempotent.
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
function bindClientTransport(clientId: string, viewId: number, connection: Connection): void {
  installAuthoritySubscriber(clientId);
  clientRegistry.attachLive(clientId, viewId);
  viewIdToClientId.set(viewId, clientId);

  const previousConnection = clientIdToConnection.get(clientId);
  if (previousConnection && previousConnection !== connection) {
    detachAllPanesForSession(clientId);
  }
  clientIdToConnection.set(clientId, connection);
  retroattachPanesForSession(clientId);
}

// Per-authority debounce; auths without persistSession silently drop.
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
  // Latest-wins coalescing: keep armed timer, overwrite pending.
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
  const conn = viewIdToConnection.get(viewId);
  viewIdToConnection.delete(viewId);
  if (clientId) {
    viewIdToClientId.delete(viewId);
    // sessionId may already be rebound to a newer viewId (refresh-before-close).
    const current = clientRegistry.get(clientId);
    if (current && current.viewId !== null && current.viewId !== viewId) {
      clientRegistry.detachRenderer(viewId);
      return;
    }
    if (conn) detachExtensionsForSession(clientId, conn);
    detachAllPanesForSession(clientId);
    clientRegistry.markDisconnected(clientId, (state) => {
      // Read userId, delete entry, THEN schedule — countUserClients depends on this order.
      const userId = clientIdToUserId.get(state.clientId);
      clientIdToUserId.delete(state.clientId);
      console.log(`[flmux] client ${state.clientId} evicted after grace period`);
      if (userId) maybeScheduleAuthorityEviction(userId);
    });
  }
  // paneEmitters self-clean via stream abort on connection close.
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
    // Web mode always has an authorizer; auth-passed implies context non-null.
    throw new Error("resolveShellModelRouter: web mode requires an auth context");
  }
  const authority = await userAuthorityRegistry.getOrCreate(context.user.name);
  return authority.router;
}

function buildShellConfig(authContext: FlmuxAuthorizationContext | null): FlmuxRendererBootstrapConfig {
  // Web only: carry the signed-in user so the renderer can show the Account
  // section. Resolve the display name fresh so a self-edit reflects without a
  // restart. Desktop (no authContext) omits `account` — no account surface.
  const account = authContext
    ? {
        name: authContext.user.name,
        displayName: webModeAuthorizer?.getUser(authContext.user.name)?.displayName ?? authContext.user.displayName
      }
    : undefined;
  return {
    mode: runtimeMode,
    appName,
    appOrigin: serverOrigin,
    projectDir,
    // Web: relative URLs so ext modules load via the page origin (proxy/Funnel), not the internal bind.
    localExtensions: createLocalExtensionLoadEntries(localExtensions, runtimeMode === "web" ? "" : serverOrigin),
    devMode: process.env.FLMUX_DEV_MODE === "1",
    workspaceTabstrip: resolveWorkspaceTabstripMode({ runtimeMode, platform: process.platform }),
    account
  };
}

function setupConnection(
  conn: Connection,
  viewId: number,
  mode: "desktop" | "web",
  authContext: FlmuxAuthorizationContext | null
) {
  viewIdToConnection.set(viewId, conn);

  const mintFresh = async (): Promise<MintedSession> => {
    const userId = mode === "desktop" ? "local" : authContext?.user.name;
    if (!userId) throw new Error("bridge.mintSession: no user resolved");
    const authority: ShellAuthority = mode === "desktop"
      ? desktopAuthority!
      : await userAuthorityRegistry!.getOrCreate(userId);
    const sessionId = mode === "desktop" ? DESKTOP_CLIENT_ID : `web_${crypto.randomUUID()}`;
    if (mode === "web") {
      if (countUserClients(userId) >= MAX_SESSIONS_PER_USER) {
        throw new Error(`session limit reached for user '${userId}' (max ${MAX_SESSIONS_PER_USER})`);
      }
      clientIdToUserId.set(sessionId, userId);
      cancelPendingAuthorityEviction(userId);
    }
    return bindMintedSession({ conn, viewId, authority, sessionId, userId, authContext });
  };

  const resumeExisting = async (resumeToken: string): Promise<MintedSession | null> => {
    if (mode === "desktop") return null;
    const userId = authContext?.user.name;
    if (!userId) return null;
    if (clientIdToUserId.get(resumeToken) !== userId) return null;
    const state = clientRegistry.get(resumeToken);
    if (!state || state.viewId !== null) return null;
    const authority = userAuthorityRegistry?.get(userId);
    if (!authority) return null;
    cancelPendingAuthorityEviction(userId);
    return bindMintedSession({ conn, viewId, authority, sessionId: resumeToken, userId, authContext });
  };

  conn.serve(flmuxBridgeCap, createBridgeImpl({
    connection: conn,
    mintSession: mintFresh,
    resumeSession: resumeExisting
  }));
}

async function bindMintedSession(opts: {
  conn: Connection;
  viewId: number;
  authority: ShellAuthority;
  sessionId: string;
  userId: string;
  authContext: FlmuxAuthorizationContext | null;
}): Promise<MintedSession> {
  const { conn, viewId, authority, sessionId, userId, authContext } = opts;
  bindClientTransport(sessionId, viewId, conn);
  await attachExtensionsForSession({ conn, sessionId, userId, authority });
  // Latest-wins routing for browser pane automation. Newer binds overwrite;
  // onClose only nulls out when the closing conn is still the active one.
  authority.browserController.setConnection(conn);
  conn.onClose(() => authority.browserController.clearConnectionIf(conn));

  const sessionImpl = createSessionImpl({
    sessionId,
    shellModel: authority.shellModel,
    assertAllowed: (method, path) => {
      if (!webModeAuthorizer) return;
      const user = webModeAuthorizer.resolveUserByName(userId);
      if (!user) throw new Error(`session.${method} '${path}': user '${userId}' not resolvable`);
      if (!webModeAuthorizer.isPathAllowed(user, method, path)) {
        throw new Error(`Access denied for user '${user.name}': ${method} '${path}'`);
      }
    },
    assertPaneKindAllowed: (path, args) => {
      if (!webModeAuthorizer || path !== "/panes/new") return;
      const kind = typeof args?.kind === "string" ? args.kind : null;
      if (!kind) return;
      const user = webModeAuthorizer.resolveUserByName(userId);
      if (!user) return;
      if (!webModeAuthorizer.isPaneKindAllowed(user, kind)) {
        throw new Error(`User '${user.name}' is not allowed to create pane kind '${kind}'`);
      }
    },
    bootstrap: () => authority.shellBootstrap(sessionId),
    buildConfig: () => buildShellConfig(authContext),
    subscribeShellEvents: (sinceSeq, emit) => {
      const replay = clientRegistry.replayAfter(sessionId, sinceSeq);
      if (replay === null) return null;
      for (const event of replay) emit(event);
      return clientRegistry.subscribeLive(sessionId, emit);
    },
    paneEmitters,
    canSubscribeTerminalForPane: (paneId) =>
      paneIdToAuthority.get(paneId) === authority && isPaneKindAllowedForUser(userId, "terminal"),
    pushLayout: (layouts) => pushLayoutForViewId(viewId, layouts)
  });

  return {
    sessionId,
    sessionImpl,
    dispose: () => releaseView(viewId)
  };
}

let nextWebViewId = 1_000_000;

const portResolution = resolveFlmuxServerPort({
  configFile: flmuxPaths.appConfigFile
});

const server = startFlmuxServer({
  rendererDir,
  appName,
  resolveShellModelRouter: resolveShellModelRouterForRequest,
  localExtensions,
  port: portResolution.port,
  publicOrigin: process.env.FLMUX_PUBLIC_ORIGIN,
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
  authorizer: webModeAuthorizer ?? undefined,
  webauthn: webauthnService ?? undefined,
  onRpcConnection:
    runtimeMode === "web"
      ? (conn, authContext) => {
          const viewId = nextWebViewId++;
          conn.onClose(() => releaseView(viewId));
          setupConnection(conn, viewId, "web", authContext);
        }
      : undefined
});
serverOrigin = server.origin;
// Spawned extensions inherit FLMUX_ORIGIN — no --origin needed.
process.env.FLMUX_ORIGIN = serverOrigin;
if (desktopAuthority) {
  // Subscribe before start() so session-restore pane.added events index correctly.
  trackPaneLifecycle(desktopAuthority);
  await desktopAuthority.start(server.origin);
}

console.log(
  `[flmux] ${runtimeMode} mode server listening at ${server.origin}` +
    (portResolution.source !== "default" ? ` (port from ${portResolution.source})` : "")
);
if (webModeAuthPaths) {
  console.log(`[flmux] auth dir: ${webModeAuthPaths.authDir}`);
  console.log(`[flmux] web origin: ${server.origin} (sign in with a passkey at /login)`);
  console.log(
    `[flmux] enroll a user: bun src/cli.ts auth enroll --user <name> --auth-dir ${webModeAuthPaths.authDir}`
  );
}

terminalService.subscribe((event: TerminalRuntimeEvent) => {
  // paneId→authority index routes terminal events; unknown panes skip.
  if (event.paneId) {
    paneIdToAuthority.get(event.paneId)?.applyTerminalEvent(event);
  }
  forwardTerminalEventToSubscribers({ event, paneEmitters });
});

async function stopRuntime() {
  // Graceful: tell install-scoped daemon to stop (tmux-style persistence covers crash paths).
  try {
    const lock = await new PtydLockFile(flmuxPaths.rootDir).load();
    if (lock) {
      await callJsonRpcIpc(lock.controlIpcPath, "daemon.stop", undefined, 2_000);
    }
  } catch {
    /* best-effort */
  }
  webauthnService?.dispose();
  terminalService.dispose?.();
  server.stop();
}

if (runtimeMode === "desktop" && app) {
  const tabstripMode = resolveWorkspaceTabstripMode({ runtimeMode, platform: process.platform });
  const win = new BrowserWindow({
    title: `flmux skeleton v${app.version} - ${app.engineName ?? "engine"} ${app.engineVersion ?? "unknown"}`,
    frame: { x: 80, y: 80, width: 1280, height: 860 },
    url: server.origin,
    titleBarStyle: tabstripMode === "titlebar" ? "hidden" : "default",
    hidden: hiddenWindow,
    preloadOrigins: [server.origin],
    serve: (conn) => {
      // Defer: `serve` may run inside BrowserWindow constructor, before webviewId is assigned.
      queueMicrotask(() => {
        const viewId = win.webviewId;
        conn.onClose(() => releaseView(viewId));
        setupConnection(conn, viewId, "desktop", null);
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
  // Web mode: Bun.serve owns the event loop; no native runtime.
}
