import { BrowserView, BrowserWindow, app } from "bunite-core";
import type { FlmuxRendererBridgeSchema, RendererShellModelBridge } from "../shared/rendererBridge";
import type { TerminalCreateInput, TerminalRuntimeEvent } from "../shared/terminal";
import { FlmuxClientRegistry } from "./clientRegistry";
import { createSessionStore, isSessionSnapshot } from "./sessionStore";
import { createShellModelRouter, installShellModelBridge } from "./shellModelBridge";
import { startFlmuxServer } from "./server";
import { forwardTerminalEventToOwnedClient } from "./terminalEventForwarding";
import { createTerminalService } from "./terminal-service";
import type { FlmuxSessionSnapshot } from "../shared/session";

process.env.BUNITE_REMOTE_DEBUGGING_PORT ??= "9227";
process.env.FLMUX_DEV_MODE ??= Bun.argv.includes("--dev") ? "1" : "";
const hiddenWindow = process.env.FLMUX_HIDDEN_WINDOW === "1";

await app.init({ logLevel: "info" });

const rendererDir = app.resolve("../dist/renderer");
const clientRegistry = new FlmuxClientRegistry();
const shellModelRouter = createShellModelRouter(clientRegistry);
const terminalService = createTerminalService();
const sessionStore = createSessionStore();
const paneOwners = new Map<string, number>();
const server = startFlmuxServer({
  rendererDir,
  shellModelRouter,
  saveSession: (snapshot) => sessionStore.save(snapshot)
});
const rendererBridgeRpc = BrowserView.defineRPC<FlmuxRendererBridgeSchema>({
  handlers: {}
}) as RendererShellModelBridge;

installShellModelBridge(shellModelRouter);

app.handle("flmux.getConfig", () => ({
  fixtureBaseUrl: `${server.origin}/fixtures`,
  appOrigin: server.origin,
  projectDir: process.cwd()
}));

app.handle("flmux.session.load", async () => {
  return sessionStore.load();
});

app.handle("flmux.session.save", async (params) => {
  if (!isSessionSnapshot(params)) {
    throw new Error("Invalid flmux session snapshot");
  }

  await sessionStore.save(params);
  return { ok: true };
});

app.handle("flmux.terminal.create", async (params, ctx) => {
  const input = params as TerminalCreateInput;
  if (input.paneId) {
    paneOwners.set(input.paneId, ctx.viewId);
  }

  return terminalService.create(input);
});

app.handle("flmux.terminal.adopt", async (params, ctx) => {
  const input = params as { rootDir: string; paneId: string };
  const result = await terminalService.adoptByPaneId(input);
  if (result.outcome === "adopted") {
    paneOwners.set(input.paneId, ctx.viewId);
  }

  return result;
});

app.handle("flmux.terminal.write", async (params) => {
  return terminalService.write(params as Parameters<typeof terminalService.write>[0]);
});

app.handle("flmux.terminal.history", async (params) => {
  return terminalService.history(params as Parameters<typeof terminalService.history>[0]);
});

app.handle("flmux.terminal.kill", async (params) => {
  return terminalService.kill(params as Parameters<typeof terminalService.kill>[0]);
});

app.handle("flmux.terminal.listRoots", async () => {
  return terminalService.listRoots();
});

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
  rpc: rendererBridgeRpc
});

clientRegistry.attachRenderer(win.webviewId, rendererBridgeRpc);

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
