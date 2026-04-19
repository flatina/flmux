import { join } from "node:path";
import { BrowserView, BrowserWindow, AppRuntime } from "bunite-core";
import type { SequencedShellCoreEvent, ShellModelAPI } from "@flmux/core/shell";
import type { FlmuxRendererBridgeSchema, FlmuxSessionSaveLayouts } from "../shared/rendererBridge";
import type { TerminalRuntimeEvent } from "../shared/terminal";
import { AttachmentRegistry } from "./attachmentRegistry";
import { FlmuxClientRegistry } from "./clientRegistry";
import { createSessionStore } from "./sessionStore";
import {
  DESKTOP_ATTACHMENT_ID,
  createDesktopShellAuthority,
  type DesktopShellAuthority
} from "./desktopShellAuthority";
import type { WebModeShellAuthority } from "./webModeShellAuthority";
import { createWebModeUserAuthorityRegistry, type WebModeUserAuthorityRegistry } from "./userAuthorityRegistry";
import { startFlmuxServer } from "./server";
import { forwardTerminalEventToOwnedClient } from "./terminalEventForwarding";
import { createTerminalService } from "./terminal-service";
import { createFlmuxHostRequestHandlers } from "./hostRequests";
import { createFlmuxWebModeAuthorizer, type FlmuxAuthorizationContext } from "./webModeAuth";
import { resolveFlmuxAuthDir, resolveFlmuxAuthPaths } from "./auth/authConfig";
import { resolveFlmuxRuntimeMode } from "./runtimeMode";
import type { FlmuxShellModelRouter } from "./shellModelBridge";
import {
  discoverConfiguredLocalExtensions,
  resolveConfiguredLocalExtensionsRootDir
} from "./localExtensions";

type ShellAuthority = Pick<
  DesktopShellAuthority | WebModeShellAuthority,
  "subscribe" | "applyTerminalEvent"
> & {
  readonly shellModel: ShellModelAPI;
  readonly router: FlmuxShellModelRouter;
  readonly clientId: string;
  persistSession?(layouts: FlmuxSessionSaveLayouts): Promise<void>;
};

const runtimeMode = resolveFlmuxRuntimeMode();
process.env.BUNITE_REMOTE_DEBUGGING_PORT ??= "9227";
process.env.FLMUX_DEV_MODE ??= Bun.argv.includes("--dev") ? "1" : "";
const hiddenWindow = process.env.FLMUX_HIDDEN_WINDOW === "1";

const app = new AppRuntime({ logLevel: "info" });
await app.ready;

const rendererDir = app.resolve("../dist/renderer");
const projectDir = app.resolve("../../..");
const localExtensionsRootDir = resolveConfiguredLocalExtensionsRootDir(app.resolve("../../../extensions"));
const clientRegistry = new FlmuxClientRegistry();
const terminalService = createTerminalService();
const sessionStore = runtimeMode === "desktop" ? createSessionStore() : null;
const paneOwners = new Map<string, number>();
const localExtensions = await discoverConfiguredLocalExtensions(localExtensionsRootDir);
const webModeAuthPaths = runtimeMode === "web" ? resolveFlmuxAuthPaths(resolveFlmuxAuthDir()) : null;
const webModeAuthorizer = webModeAuthPaths ? createFlmuxWebModeAuthorizer(webModeAuthPaths) : null;

const desktopAuthority: DesktopShellAuthority | null = runtimeMode === "desktop" && sessionStore
  ? await createDesktopShellAuthority({
      projectDir,
      runtimeLabel: "desktop local-http preload ok",
      terminalService,
      sessionStore,
      clientRegistry,
      localExtensions
    })
  : null;

let serverOrigin = "";

// Web mode: `Map<userId, WebModeShellAuthority>`. Each authenticated user
// gets an isolated `ShellCore` on first reach. Session persistence is NOT
// per-user yet — desktop keeps its single `sessionStore`, web has none
// (B2 Phase 2+ concern).
const userAuthorityRegistry: WebModeUserAuthorityRegistry | null = runtimeMode === "web"
  ? createWebModeUserAuthorityRegistry({
      projectDir,
      terminalService,
      clientRegistry,
      localExtensions,
      getOrigin: () => serverOrigin,
      onAuthorityCreated: (_userId, authority) => {
        trackPaneLifecycle(authority);
      },
      // Per-user session persistence under the auth dir — each
      // authenticated user gets `<authDir>/sessions/<userId>/session.json`.
      // `webModeAuthPaths` is always set when runtimeMode is "web".
      sessionsDir: webModeAuthPaths ? join(webModeAuthPaths.authDir, "sessions") : undefined
    })
  : null;

// Mode exclusivity guard: `resolveAuthorityForViewId` branches on
// `desktopAuthority` first, which is safe only when exactly one of the
// two is configured. A mixed-mode misconfiguration would silently route
// every web viewId to the desktop authority.
if ((desktopAuthority === null) === (userAuthorityRegistry === null)) {
  throw new Error(
    `Exactly one of desktopAuthority/userAuthorityRegistry must be configured (runtime mode: '${runtimeMode}')`
  );
}

const attachmentRegistry = new AttachmentRegistry();
const viewIdToAttachmentId = new Map<number, string>();
// Web-only: records which user owns each minted attachmentId so WS
// register + shellModel.path.* calls route to the right authority.
const attachmentIdToUserId = new Map<string, string>();
// Terminal event routing index: paneId → owning authority. Replaces the
// naive fan-out-to-every-authority pattern so terminal events apply to
// exactly the authority that owns the pane, not every authority whose
// ShellCore happens to lack the id. Kept in sync via pane.added /
// pane.removed subscribers installed once per authority (desktop at
// startup, web on first getOrCreate via the registry's onAuthorityCreated
// hook).
const paneIdToAuthority = new Map<string, ShellAuthority>();

function trackPaneLifecycle(authority: ShellAuthority): () => void {
  return authority.subscribe((event) => {
    if (event.topic === "pane.added") {
      paneIdToAuthority.set(event.payload.paneId, authority);
    } else if (event.topic === "pane.removed") {
      paneIdToAuthority.delete(event.payload.paneId);
    }
  });
}

function scopeMatches(event: SequencedShellCoreEvent, attachmentId: string): boolean {
  if (event.scope === "all") return true;
  return event.targetAttachmentId === attachmentId;
}

/**
 * Resolve the authority an attachment belongs to. Desktop has a single
 * authority and ignores `attachmentId`; web looks up the owning user via
 * the bootstrap-time mapping. Returns null in web mode if the attachment
 * is unknown (e.g. stale cookie after server restart).
 */
function resolveAuthorityForAttachment(attachmentId: string): ShellAuthority | null {
  if (desktopAuthority) return desktopAuthority;
  const userId = attachmentIdToUserId.get(attachmentId);
  if (!userId) return null;
  return userAuthorityRegistry?.get(userId) ?? null;
}

function resolveAuthorityForViewId(
  viewId: number,
  hints?: { attachmentId?: string }
): ShellAuthority | null {
  if (desktopAuthority) return desktopAuthority;
  const attachmentId = hints?.attachmentId ?? viewIdToAttachmentId.get(viewId);
  if (!attachmentId) return null;
  return resolveAuthorityForAttachment(attachmentId);
}

/**
 * Install the always-on ring-buffer subscriber for `attachmentId`. Called
 * at attachment creation time (desktop preload register, web HTTP bootstrap)
 * so the buffer is alive from the moment the attachment exists — including
 * the window between `/api/shell/bootstrap` response and the browser's WS
 * `flmux.client.register` call. Idempotent.
 */
function ensureBufferSubscriber(attachmentId: string) {
  const authority = resolveAuthorityForAttachment(attachmentId);
  if (!authority) return;
  const state = attachmentRegistry.ensure(attachmentId);
  if (state.unsubscribeBuffer) return;
  const unsub = authority.subscribe((event) => {
    if (scopeMatches(event, attachmentId)) {
      attachmentRegistry.pushBuffered(attachmentId, event);
    }
  });
  attachmentRegistry.setBufferSubscriber(attachmentId, unsub);
}

/**
 * Bind a connected transport (desktop preload or web ws client) to an
 * attachment's live event forwarder. The buffer subscriber is installed
 * separately via `ensureBufferSubscriber` at attachment creation. On
 * reconnect this is called again — the live forwarder is replaced, the
 * buffer subscriber is untouched.
 */
function installAttachmentForwarder(attachmentId: string, viewId: number) {
  const authority = resolveAuthorityForAttachment(attachmentId);
  if (!authority) return;
  const client = clientRegistry.resolveByViewId(viewId);
  if (!client) return;

  ensureBufferSubscriber(attachmentId);

  const unsubLive = authority.subscribe((event) => {
    if (!scopeMatches(event, attachmentId)) return;
    client.bridge.sendProxy["shellCore.event"](event);
  });
  attachmentRegistry.attachLive(attachmentId, viewId, unsubLive);
  viewIdToAttachmentId.set(viewId, attachmentId);
}

/**
 * Web-mode attachment binding: replay any buffered events the client missed
 * between bootstrap and register, then install the live forwarder. Returns
 * `"rebootstrap-required"` when the client's `lastAppliedSeq` is older than
 * the ring buffer's oldest seq — the client drops local state and re-POSTs
 * `/api/shell/bootstrap`.
 */
function bindWebAttachment(
  viewId: number,
  binding: { attachmentId: string; lastAppliedSeq: number }
): "rebootstrap-required" | void {
  const replayed = attachmentRegistry.replayAfter(binding.attachmentId, binding.lastAppliedSeq);
  if (replayed === null) {
    // Buffer rolled past the client's seq — the stale attachment entry is
    // useless now; the client will mint a fresh id on re-bootstrap. Drop
    // the attachmentId→user mapping too so the entry doesn't linger.
    attachmentRegistry.evict(binding.attachmentId);
    attachmentIdToUserId.delete(binding.attachmentId);
    return "rebootstrap-required";
  }
  const client = clientRegistry.resolveByViewId(viewId);
  if (client) {
    for (const event of replayed) {
      client.bridge.sendProxy["shellCore.event"](event);
    }
  }
  installAttachmentForwarder(binding.attachmentId, viewId);
}

function mintWebAttachmentId(): string {
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
  const attachmentId = viewIdToAttachmentId.get(viewId);
  if (attachmentId) {
    viewIdToAttachmentId.delete(viewId);
    attachmentRegistry.markDisconnected(attachmentId, (state) => {
      attachmentIdToUserId.delete(state.attachmentId);
      console.log(`[flmux] attachment ${state.attachmentId} evicted after grace period`);
    });
  }
  for (const [paneId, owner] of paneOwners.entries()) {
    if (owner === viewId) paneOwners.delete(paneId);
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

const resolveShellModel = (viewId: number, hints?: { attachmentId?: string }): ShellModelAPI | null => {
  return resolveAuthorityForViewId(viewId, hints)?.shellModel ?? null;
};

const resolveShellModelRouter = (viewId: number, hints?: { attachmentId?: string }): FlmuxShellModelRouter | null => {
  return resolveAuthorityForViewId(viewId, hints)?.router ?? null;
};

const rendererRpc = BrowserView.defineRPC<FlmuxRendererBridgeSchema>({
  handlers: {
    requests: createFlmuxHostRequestHandlers({
      mode: runtimeMode,
      getAppOrigin: () => serverOrigin,
      getProjectDir: () => projectDir,
      getAuthorityClientId: () => desktopAuthorityClientId,
      getCallerViewId: requireDesktopViewId,
      getCallerAttachmentId: (viewId) => viewIdToAttachmentId.get(viewId) ?? null,
      paneOwners,
      resolveShellModel,
      resolveShellModelRouter,
      terminalService,
      localExtensions,
      desktopAuthority,
      onClientRegister: (viewId) => {
        // Desktop CEF is a single attachment; its viewId binds to the
        // stable "local" identity for the life of the process. Web clients
        // reach the separate handler below with a `binding` arg — the
        // desktop preload never passes one.
        installAttachmentForwarder(DESKTOP_ATTACHMENT_ID, viewId);
      },
      pushLayout: pushLayoutForViewId
    })
  }
});

type WebClient = NonNullable<Parameters<NonNullable<typeof rendererRpc.webHandler.onWebClientConnected>>[0]>;

let nextWebViewId = 1_000_000;
const webViewIds = new WeakMap<WebClient, number>();

rendererRpc.webHandler.onWebClientConnected = (client) => {
  const viewId = nextWebViewId++;
  webViewIds.set(client, viewId);
  client.rpc.setRequestHandler(createFlmuxHostRequestHandlers({
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
    getCallerAttachmentId: (id) => viewIdToAttachmentId.get(id) ?? null,
    paneOwners,
    resolveShellModel,
    resolveShellModelRouter,
    terminalService,
    localExtensions,
    desktopAuthority,
    onClientRegister: (registeredViewId, binding) => {
      if (!binding) {
        throw new Error(
          "flmux.client.register: web clients must pass {attachmentId, lastAppliedSeq} " +
          "obtained from /api/shell/bootstrap"
        );
      }
      return bindWebAttachment(registeredViewId, binding);
    },
    // Per-user sessionStore persistence (B2 Phase 2): the user's
    // authority owns its own store at `<authDir>/sessions/<userId>/session.json`
    // — main resolves the right one from the caller's viewId.
    pushLayout: pushLayoutForViewId
  }));
  clientRegistry.attachRenderer(viewId, client.rpc);
};

rendererRpc.webHandler.onWebClientDisconnected = (client) => {
  const viewId = webViewIds.get(client);
  if (viewId == null) return;
  releaseView(viewId);
};

const server = startFlmuxServer({
  rendererDir,
  resolveShellModelRouter: resolveShellModelRouterForRequest,
  localExtensions,
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
  // lazily creates the user's authority, mints a fresh attachmentId,
  // records the attachmentId→userId mapping so WS register + shellModel
  // calls route to the right authority, installs the buffer subscriber
  // BEFORE composing the snapshot (so events emitted by shellBootstrap or
  // concurrent callers land in the buffer), and arms the unbound-grace
  // timer so an attachment whose WS register never arrives doesn't leak
  // a permanent shellCore subscriber.
  bootstrapAttachment: userAuthorityRegistry
    ? async (context) => {
        if (!context) {
          throw new Error("/api/shell/bootstrap: web mode requires an auth context");
        }
        const userId = context.user.name;
        const authority = await userAuthorityRegistry.getOrCreate(userId);
        const attachmentId = mintWebAttachmentId();
        attachmentIdToUserId.set(attachmentId, userId);
        ensureBufferSubscriber(attachmentId);
        attachmentRegistry.markDisconnected(attachmentId, (state) => {
          attachmentIdToUserId.delete(state.attachmentId);
          console.log(`[flmux] unbound attachment ${state.attachmentId} evicted after grace`);
        });
        return authority.shellBootstrap(attachmentId);
      }
    : undefined,
  authorizer: webModeAuthorizer ?? undefined,
  rpcWebHandler: rendererRpc.webHandler
});
serverOrigin = server.origin;
if (desktopAuthority) {
  // Subscribe BEFORE start() so any pane.added emitted during session
  // restore indexes correctly for terminal routing.
  trackPaneLifecycle(desktopAuthority);
  await desktopAuthority.start(server.origin);
}

console.log(`[flmux] ${runtimeMode} mode server listening at ${server.origin}`);
if (webModeAuthPaths) {
  console.log(`[flmux] auth dir: ${webModeAuthPaths.authDir}`);
  console.log(`[flmux] web origin: ${server.origin} (append ?token=<issued-token> on first attach)`);
  console.log(`[flmux] issue tokens via: bun src/cli.ts tokens issue --user <name> --auth-dir ${webModeAuthPaths.authDir}`);
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
  forwardTerminalEventToOwnedClient({
    event,
    paneOwners,
    clientRegistry
  });
});

function stopRuntime() {
  terminalService.dispose?.();
  server.stop();
}

if (runtimeMode === "desktop") {
  const win = new BrowserWindow({
    title: `flmux skeleton v${app.version} - CEF ${app.cefVersion ?? "unknown"}`,
    frame: { x: 80, y: 80, width: 1280, height: 860 },
    url: server.origin,
    titleBarStyle: "default",
    hidden: hiddenWindow,
    preloadOrigins: [server.origin],
    rpc: rendererRpc
  });

  desktopViewId = win.webviewId;
  clientRegistry.attachRenderer(win.webviewId, rendererRpc);

  win.on("close", () => {
    releaseView(win.webviewId);
    stopRuntime();
  });
} else {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      stopRuntime();
      process.exit(0);
    });
  }
}

app.run();
