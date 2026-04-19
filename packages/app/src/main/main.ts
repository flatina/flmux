import { BrowserView, BrowserWindow, AppRuntime } from "bunite-core";
import type { SequencedShellCoreEvent } from "@flmux/core/shell";
import type { FlmuxRendererBridgeSchema } from "../shared/rendererBridge";
import type { TerminalRuntimeEvent } from "../shared/terminal";
import { AttachmentRegistry } from "./attachmentRegistry";
import { FlmuxClientRegistry } from "./clientRegistry";
import { createSessionStore } from "./sessionStore";
import { createDesktopShellAuthority, type DesktopShellAuthority } from "./desktopShellAuthority";
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

/**
 * Desktop CEF attachment is a single, stable identity. Web browser
 * attachments get per-connection uuids in B1d (tied to the cookie
 * attachmentId returned by /api/shell/bootstrap).
 */
const DESKTOP_ATTACHMENT_ID = "local";

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
if (!shellModelRouter) {
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
 * Bind a transport (desktop preload or web ws client) to an attachment.
 * Runs two subscribers against the shell core:
 *   1. Always-on buffer: writes scope-matched events into the attachment's
 *      ring buffer, independent of live connection status. Installed once
 *      per attachment; preserved across disconnect+reconnect.
 *   2. Live forwarder: scope-matched + pushed through the bridge. Replaced
 *      on reconnect.
 */
function installAttachmentForwarder(attachmentId: string, viewId: number) {
  if (!shellAuthority) return;
  const client = clientRegistry.resolveByViewId(viewId);
  if (!client) return;

  const state = attachmentRegistry.ensure(attachmentId);
  if (!state.unsubscribeBuffer) {
    const unsubBuffer = shellAuthority.subscribe((event) => {
      if (scopeMatches(event, attachmentId)) {
        attachmentRegistry.pushBuffered(attachmentId, event);
      }
    });
    attachmentRegistry.setBufferSubscriber(attachmentId, unsubBuffer);
  }

  const unsubLive = shellAuthority.subscribe((event) => {
    if (!scopeMatches(event, attachmentId)) return;
    client.bridge.sendProxy["shellCore.event"](event);
  });
  attachmentRegistry.attachLive(attachmentId, viewId, unsubLive);
  viewIdToAttachmentId.set(viewId, attachmentId);
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
      terminalService,
      localExtensions,
      desktopAuthority,
      onClientRegister: (viewId) => {
        // Desktop CEF is a single attachment; its viewId binds to the
        // stable "local" identity for the life of the process.
        installAttachmentForwarder(DESKTOP_ATTACHMENT_ID, viewId);
      }
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
    terminalService,
    localExtensions,
    desktopAuthority,
    // Web-mode attachment binding lands in B1d — cookie-driven identity
    // from /api/shell/bootstrap. B1c leaves onClientRegister a no-op for
    // web clients so the infrastructure compiles without a browser.
    onClientRegister: () => {}
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
