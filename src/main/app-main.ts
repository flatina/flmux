import { join } from "node:path";
import { BrowserView, BrowserWindow } from "electrobun/bun";
import type { BootstrapState } from "../shared/bootstrap-state";
import { createFlmuxLastFile } from "../shared/flmux-last";
import type { HostPushMessage, HostPushPayload } from "../shared/host-rpc";
import { createSessionId } from "../shared/ids";
import { getAppRpcIpcPath } from "../shared/ipc-paths";
import { info, setLogLevel } from "../shared/logger";
import type { MainviewRpcSchema } from "../shared/mainview-rpc";
import { type StartedAppRpcServer, startAppRpcServer } from "./app-rpc-server";
import { buildWebRenderer } from "./build-web-renderer";
import { probeCdpPort } from "./cdp-discovery";
import { loadConfig } from "./config-loader";
import { buildExtensionRegistry, discoverExtensions } from "./extension-discovery";
import { FlmuxLastStore } from "./flmux-last-store";
import { createHostRpcDispatcher } from "./host-rpc";
import { PtydClient } from "./ptyd-client";
import { resolveStartupSessionId } from "./ptyd-session-recovery";
import { RendererWorkspaceBridge } from "./renderer-workspace-bridge";
import { resolveAppWorkingDirectory, resolveWebRoot, resolveWorkspaceRoot } from "./runtime-paths";
import { startWebServer } from "./web-server";
import { startWebUiServer, type WebUiServer } from "./web-ui-server";

export async function runAppMain(): Promise<void> {
  const config = loadConfig();
  const shouldRestore =
    config.app.restoreLayout && !process.argv.includes("--fresh") && process.env.FLMUX_FRESH !== "1";
  const sessionId = (await resolveStartupSessionId()) ?? createSessionId();
  const flmuxLastStore = new FlmuxLastStore();
  const initialRestoreFile = shouldRestore ? await flmuxLastStore.load() : null;
  const workspaceCwd = resolveAppWorkingDirectory();
  const webRoot = resolveWebRoot();
  const appRpcIpcPath = getAppRpcIpcPath(sessionId);
  process.env.FLMUX_ROOT = workspaceCwd;
  setLogLevel(config.log.level);
  info("app", `starting session=${sessionId} root=${workspaceCwd}`);
  let mainWindow: BrowserWindow;
  let appRpcServer: StartedAppRpcServer | null = null;
  let shuttingDown = false;

  const webServer = startWebServer({ staticRoot: webRoot });
  const discoveredExtensions = discoverExtensions(workspaceCwd);
  if (discoveredExtensions.length > 0) {
    info(
      "ext",
      `discovered ${discoveredExtensions.length}: ${discoveredExtensions.map((e) => e.manifest.id).join(", ")}`
    );
  }

  const bootstrapState: BootstrapState = {
    sessionId,
    platform: process.platform,
    cwd: workspaceCwd,
    browserPaneDefaultAdapter: "electrobun-native",
    terminalRendererDefault: "xterm",
    liveTerminalRuntimes: [],
    terminalRuntimeOwner: "none",
    extensions: buildExtensionRegistry(discoveredExtensions),
    restoreLayout: shouldRestore,
    webServerUrl: webServer.url,
    browserAutomation: {
      cdpBaseUrl: null
    }
  };

  const ptydClient = await PtydClient.start({
    sessionId,
    push: publishHostMessage
  });
  info("ptyd", `connected terminals=${ptydClient.list().length}`);

  bootstrapState.liveTerminalRuntimes = ptydClient.list();
  bootstrapState.terminalRuntimeOwner = "ptyd";
  const hostRpcDispatcher = createHostRpcDispatcher({
    bootstrapState,
    flmuxLastStore,
    workspaceRoot: workspaceCwd,
    discoveredExtensions,
    ptydClient,
    getMainWindow: () => mainWindow,
    requestQuit,
    syncTerminalBootstrapState
  });

  const rpc = BrowserView.defineRPC<MainviewRpcSchema>({
    maxRequestTime: 15_000,
    handlers: {
      requests: hostRpcDispatcher.handlers,
      messages: {}
    }
  });

  mainWindow = new BrowserWindow({
    title: "flmux",
    titleBarStyle: "hidden",
    url: "views://mainview/index.html",
    rpc,
    renderer: "native",
    frame: initialRestoreFile?.window ?? {
      width: 1440,
      height: 920,
      x: 120,
      y: 80,
      maximized: false
    }
  });

  if (initialRestoreFile?.window?.maximized) {
    mainWindow.maximize();
  }

  const workspaceBridge = new RendererWorkspaceBridge(() => mainWindow);

  // Probe CDP port asynchronously — updates cdpBaseUrl when found
  void probeCdpPort().then((cdpBaseUrl) => {
    if (cdpBaseUrl) {
      bootstrapState.browserAutomation.cdpBaseUrl = cdpBaseUrl;
      workspaceBridge.setCdpBaseUrl(cdpBaseUrl);
    }
  });

  appRpcServer = await startAppRpcServer({
    bridge: workspaceBridge,
    sessionId,
    workspaceRoot: workspaceCwd,
    ipcPath: appRpcIpcPath,
    pid: process.pid,
    platform: process.platform,
    requestQuit
  });

  // Web UI server (optional, enabled via [web] in flmux.toml)
  let webUiServer: WebUiServer | null = null;
  if (config.web.enabled) {
    const projectRoot = resolveWorkspaceRoot() ?? workspaceCwd;
    const webOutputDir = join(projectRoot, "build", "web");
    await buildWebRenderer(projectRoot, webOutputDir);

    webUiServer = startWebUiServer({
      host: config.web.host,
      port: config.web.port,
      viewsDir: webOutputDir,
      handleHostRpc: (method, params) => hostRpcDispatcher.invoke(method, params),
      handleRendererRpc: () => {}
    });
  }

  process.on("beforeExit", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  function requestQuit(): void {
    try {
      mainWindow.close();
    } catch {
      // best effort
    }
    void shutdown();
  }

  async function shutdown(): Promise<void> {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    info("app", "shutting down");

    try {
      const frame = mainWindow.getFrame();
      const existing = await flmuxLastStore.load();
      const file = createFlmuxLastFile({
        activePaneId: existing?.activePaneId ?? null,
        workspaceLayout: existing?.workspaceLayout ?? null,
        window: {
          x: frame.x,
          y: frame.y,
          width: frame.width,
          height: frame.height,
          maximized: mainWindow.isMaximized()
        }
      });
      await flmuxLastStore.save(file);
    } catch {
      // best effort persistence on shutdown
    }

    if (appRpcServer) {
      await appRpcServer.stop();
      appRpcServer = null;
    }

    await ptydClient.stopDaemon();
    await ptydClient.dispose();
    webServer.stop();
    webUiServer?.stop();
  }

  function syncTerminalBootstrapState(): void {
    bootstrapState.liveTerminalRuntimes = ptydClient.list();
  }

  function publishHostMessage<Message extends HostPushMessage>(
    message: Message,
    payload: HostPushPayload<Message>
  ): void {
    if (message === "terminal.event") {
      syncTerminalBootstrapState();
    }

    const send = (mainWindow?.webview.rpc as { send?: Record<string, (input: unknown) => void> } | undefined)?.send;
    send?.[message]?.(payload);

    // Also push to web UI clients
    webUiServer?.pushMessage(message, payload);
  }
}
