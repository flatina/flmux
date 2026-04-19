import { BrowserView, BrowserWindow, AppRuntime } from "bunite-core";
import type { SequencedShellCoreEvent } from "@flmux/core/shell";
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
import { createWebModeShellAuthority, type WebModeShellAuthority } from "./webModeShellAuthority";
import { startFlmuxServer } from "./server";
import { forwardTerminalEventToOwnedClient } from "./terminalEventForwarding";
import { createTerminalService } from "./terminal-service";
import { createFlmuxHostRequestHandlers } from "./hostRequests";
import { createFlmuxWebModeAuthorizer } from "./webModeAuth";
import { resolveFlmuxAuthDir, resolveFlmuxAuthPaths } from "./auth/authConfig";
import { resolveFlmuxRuntimeMode } from "./runtimeMode";
import {
  discoverConfiguredLocalExtensions,
  resolveConfiguredLocalExtensionsRootDir
} from "./localExtensions";

type ShellAuthority = Pick<
  DesktopShellAuthority | WebModeShellAuthority,
  "subscribe"
>;

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

const webModeShellAuthority = runtimeMode === "web"
  ? await createWebModeShellAuthority({
      projectDir,
      runtimeLabel: "web server authority",
      terminalService,
      clientRegistry,
      localExtensions
    })
  : null;

const shellModelRouter = desktopAuthority?.router ?? webModeShellAuthority?.router;
const shellModel = desktopAuthority?.shellModel ?? webModeShellAuthority?.shellModel;
if (!shellModelRouter || !shellModel) {
  throw new Error(`No shell model authority configured for runtime mode '${runtimeMode}'`);
}

const authorityClientId = desktopAuthority?.clientId ?? webModeShellAuthority?.clientId ?? null;

const shellAuthority: ShellAuthority | null = desktopAuthority ?? webModeShellAuthority ?? null;

const attachmentRegistry = new AttachmentRegistry();
const viewIdToAttachmentId = new Map<number, string>();

function scopeMatches(event: SequencedShellCoreEvent, attachmentId: string): boolean {
  if (event.scope === "all") return true;
  return event.targetAttachmentId === attachmentId;
}

/**
 * Install the always-on ring-buffer subscriber for `attachmentId`. Called
 * at attachment creation time (desktop preload register, web HTTP bootstrap)
 * so the buffer is alive from the moment the attachment exists — including
 * the window between `/api/shell/bootstrap` response and the browser's WS
 * `flmux.client.register` call. Idempotent.
 */
function ensureBufferSubscriber(attachmentId: string) {
  if (!shellAuthority) return;
  const state = attachmentRegistry.ensure(attachmentId);
  if (state.unsubscribeBuffer) return;
  const unsub = shellAuthority.subscribe((event) => {
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
  if (!shellAuthority) return;
  const client = clientRegistry.resolveByViewId(viewId);
  if (!client) return;

  ensureBufferSubscriber(attachmentId);

  const unsubLive = shellAuthority.subscribe((event) => {
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
    // useless now; the client will mint a fresh id on re-bootstrap.
    attachmentRegistry.evict(binding.attachmentId);
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

/** Main-side session-save debounce. Web mode has no `sessionStore` in
 * B1d — `pushLayout` is a no-op there (B2 gap). */
const SESSION_SAVE_DEBOUNCE_MS = 250;
let pendingLayouts: FlmuxSessionSaveLayouts | null = null;
let layoutDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function pushLayout(layouts: FlmuxSessionSaveLayouts) {
  if (!desktopAuthority) return;
  // Coalescing shape: overwrite pendingLayouts + early-return keeps the
  // already-armed timer; the latest layout wins when it fires. A burst of
  // pushes inside the debounce window writes once.
  pendingLayouts = layouts;
  if (layoutDebounceTimer) return;
  layoutDebounceTimer = setTimeout(() => {
    layoutDebounceTimer = null;
    const toWrite = pendingLayouts;
    pendingLayouts = null;
    if (!toWrite) return;
    void desktopAuthority!.persistSession(toWrite).catch((error) => {
      console.warn("[flmux] failed to persist session layouts", error);
    });
  }, SESSION_SAVE_DEBOUNCE_MS);
}

function releaseView(viewId: number) {
  const attachmentId = viewIdToAttachmentId.get(viewId);
  if (attachmentId) {
    viewIdToAttachmentId.delete(viewId);
    attachmentRegistry.markDisconnected(attachmentId, (state) => {
      console.log(`[flmux] attachment ${state.attachmentId} evicted after grace period`);
    });
  }
  for (const [paneId, owner] of paneOwners.entries()) {
    if (owner === viewId) paneOwners.delete(paneId);
  }
  clientRegistry.detachRenderer(viewId);
}

let desktopViewId: number | null = null;
let serverOrigin = "";

function requireDesktopViewId() {
  if (desktopViewId == null) {
    throw new Error("Desktop renderer is not attached");
  }
  return desktopViewId;
}

const rendererRpc = BrowserView.defineRPC<FlmuxRendererBridgeSchema>({
  handlers: {
    requests: createFlmuxHostRequestHandlers({
      mode: runtimeMode,
      getAppOrigin: () => serverOrigin,
      getProjectDir: () => projectDir,
      getAuthorityClientId: () => authorityClientId,
      getCallerViewId: requireDesktopViewId,
      getCallerAttachmentId: (viewId) => viewIdToAttachmentId.get(viewId) ?? null,
      paneOwners,
      shellModelRouter,
      shellModel,
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
      pushLayout
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
    getAuthorityClientId: () => authorityClientId,
    getCallerViewId: () => viewId,
    getCallerAttachmentId: (id) => viewIdToAttachmentId.get(id) ?? null,
    paneOwners,
    shellModelRouter,
    shellModel,
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
    // Web has no sessionStore in B1d (desktop-only). See `pushLayout`
    // definition above — web pushes are silently dropped (B2 gap).
    pushLayout
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
  shellModelRouter,
  localExtensions,
  saveSession: desktopAuthority
    ? (layouts) => desktopAuthority.persistSession(layouts)
    : undefined,
  // Web-mode HTTP bootstrap. Each call mints a fresh attachmentId, installs
  // its ring-buffer subscriber BEFORE composing the snapshot (so events
  // emitted by `shellBootstrap` or by concurrent callers during the HTTP
  // round-trip land in the buffer for replay at register time), then runs
  // the authority's sync bootstrap. The grace timer armed here evicts the
  // attachment if the browser never completes register (crashed tab, or
  // rebootstrap-required before forwarder install) — without it, the
  // shellCore subscriber would leak for the process lifetime.
  bootstrapAttachment: webModeShellAuthority
    ? () => {
        const attachmentId = mintWebAttachmentId();
        ensureBufferSubscriber(attachmentId);
        attachmentRegistry.markDisconnected(attachmentId, (state) => {
          console.log(`[flmux] unbound attachment ${state.attachmentId} evicted after grace`);
        });
        return webModeShellAuthority.shellBootstrap(attachmentId);
      }
    : undefined,
  authorizer: webModeAuthorizer ?? undefined,
  rpcWebHandler: rendererRpc.webHandler
});
serverOrigin = server.origin;
if (desktopAuthority) {
  await desktopAuthority.start(server.origin);
}
if (webModeShellAuthority) {
  await webModeShellAuthority.start(server.origin);
}

console.log(`[flmux] ${runtimeMode} mode server listening at ${server.origin}`);
if (webModeAuthPaths) {
  console.log(`[flmux] auth dir: ${webModeAuthPaths.authDir}`);
  console.log(`[flmux] web origin: ${server.origin} (append ?token=<issued-token> on first attach)`);
  console.log(`[flmux] issue tokens via: bun src/cli.ts tokens issue --user <name> --auth-dir ${webModeAuthPaths.authDir}`);
}

terminalService.subscribe((event: TerminalRuntimeEvent) => {
  desktopAuthority?.applyTerminalEvent(event);
  webModeShellAuthority?.applyTerminalEvent(event);
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
