import { BrowserView, BrowserWindow, AppRuntime } from "bunite-core";
import type { FlmuxRendererBridgeSchema } from "../shared/rendererBridge";
import type { TerminalRuntimeEvent } from "../shared/terminal";
import { FlmuxClientRegistry } from "./clientRegistry";
import { createSessionStore, isSessionSnapshot } from "./sessionStore";
import { createShellModelRouter } from "./shellModelBridge";
import { startFlmuxServer } from "./server";
import { forwardTerminalEventToOwnedClient } from "./terminalEventForwarding";
import { createTerminalService } from "./terminal-service";
import { discoverLocalExtensionCatalog } from "./localExtensions";

process.env.BUNITE_REMOTE_DEBUGGING_PORT ??= "9227";
process.env.FLMUX_DEV_MODE ??= Bun.argv.includes("--dev") ? "1" : "";
const hiddenWindow = process.env.FLMUX_HIDDEN_WINDOW === "1";

const app = new AppRuntime({ logLevel: "info" });
await app.ready;

const rendererDir = app.resolve("../dist/renderer");
const projectDir = app.resolve("../../..");
const localExtensionsRootDir = app.resolve("../../../extensions");
const clientRegistry = new FlmuxClientRegistry();
const shellModelRouter = createShellModelRouter(clientRegistry);
const terminalService = createTerminalService();
const sessionStore = createSessionStore();
const paneOwners = new Map<string, number>();
const localExtensions = await discoverLocalExtensionCatalog(localExtensionsRootDir);

let desktopViewId = -1;

const rendererRpc = BrowserView.defineRPC<FlmuxRendererBridgeSchema>({
  handlers: {
    requests: {
      "flmux.getConfig": () => ({
        fixtureBaseUrl: `${server.origin}/fixtures`,
        appOrigin: server.origin,
        projectDir,
        localExtensions
      }),
      "flmux.client.register": () => {
        return shellModelRouter.registerClient(desktopViewId);
      },
      "flmux.session.load": () => {
        return sessionStore.load();
      },
      "flmux.session.save": async (params) => {
        if (!isSessionSnapshot(params)) {
          throw new Error("Invalid flmux session snapshot");
        }
        await sessionStore.save(params);
        return { ok: true as const };
      },
      "flmux.terminal.create": async (params) => {
        if (params.paneId) {
          paneOwners.set(params.paneId, desktopViewId);
        }
        return terminalService.create(params);
      },
      "flmux.terminal.adopt": async (params) => {
        const result = await terminalService.adoptByPaneId(params);
        if (result.outcome === "adopted") {
          paneOwners.set(params.paneId, desktopViewId);
        }
        return result;
      },
      "flmux.terminal.write": (params) => {
        return terminalService.write(params);
      },
      "flmux.terminal.resize": (params) => {
        return terminalService.resize(params);
      },
      "flmux.terminal.history": (params) => {
        return terminalService.history(params);
      },
      "flmux.terminal.kill": (params) => {
        return terminalService.kill(params);
      },
      "flmux.terminal.listRoots": () => {
        return terminalService.listRoots();
      }
    }
  }
});

type WebClient = NonNullable<Parameters<NonNullable<typeof rendererRpc.webHandler.onWebClientConnected>>[0]>;

let nextWebViewId = 1_000_000;
const webViewIds = new WeakMap<WebClient, number>();

rendererRpc.webHandler.onWebClientConnected = (client) => {
  const viewId = nextWebViewId++;
  webViewIds.set(client, viewId);
  clientRegistry.attachRenderer(viewId, client.rpc);
  shellModelRouter.registerClient(viewId);
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
  saveSession: (snapshot) => sessionStore.save(snapshot),
  rpcWebHandler: rendererRpc.webHandler
});

console.log(`[flmux] server listening at ${server.origin}`);

terminalService.subscribe((event: TerminalRuntimeEvent) => {
  forwardTerminalEventToOwnedClient({
    event,
    paneOwners,
    clientRegistry
  });
});

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
  terminalService.dispose?.();
  clientRegistry.detachRenderer(win.webviewId);
  server.stop();
});

app.run();
