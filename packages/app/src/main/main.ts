import { BrowserView, BrowserWindow, AppRuntime } from "bunite-core";
import type { FlmuxRendererBridgeSchema } from "../shared/rendererBridge";
import type { TerminalRuntimeEvent } from "../shared/terminal";
import { FlmuxClientRegistry } from "./clientRegistry";
import { createSessionStore } from "./sessionStore";
import { createShellModelRouter } from "./shellModelBridge";
import { createWebModeShellAuthority } from "./webModeShellAuthority";
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
const webModeShellAuthority = runtimeMode === "web"
  ? await createWebModeShellAuthority({
      projectDir,
      runtimeLabel: "web server authority",
      terminalService,
      clientRegistry,
      localExtensions
    })
  : null;
const shellModelRouter = webModeShellAuthority?.router ?? createShellModelRouter(clientRegistry);

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
      getAuthorityClientId: () => webModeShellAuthority?.clientId ?? null,
      getCallerViewId: requireDesktopViewId,
      paneOwners,
      shellModelRouter,
      terminalService,
      localExtensions,
      sessionStore
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
    getAuthorityClientId: () => webModeShellAuthority?.clientId ?? null,
    getCallerViewId: () => viewId,
    paneOwners,
    shellModelRouter,
    terminalService,
    localExtensions,
    sessionStore
  }));
  clientRegistry.attachRenderer(viewId, client.rpc);
};

rendererRpc.webHandler.onWebClientDisconnected = (client) => {
  const viewId = webViewIds.get(client);
  if (viewId == null) return;
  for (const [paneId, owner] of paneOwners.entries()) {
    if (owner === viewId) paneOwners.delete(paneId);
  }
  clientRegistry.detachRenderer(viewId);
};

const server = startFlmuxServer({
  rendererDir,
  shellModelRouter,
  localExtensions,
  saveSession: sessionStore ? (snapshot) => sessionStore.save(snapshot) : undefined,
  authorizer: webModeAuthorizer ?? undefined,
  rpcWebHandler: rendererRpc.webHandler
});
serverOrigin = server.origin;
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
    for (const [paneId, viewId] of paneOwners.entries()) {
      if (viewId === win.webviewId) {
        paneOwners.delete(paneId);
      }
    }
    clientRegistry.detachRenderer(win.webviewId);
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
