import { join } from "node:path";
import { BrowserView, BrowserWindow, Utils } from "electrobun/bun";
import { createSessionId } from "../../lib/ids";
import { sleep } from "../../lib/timers";
import { getAppRpcIpcPath, getPropertyEventsIpcPath } from "../../lib/ipc/ipc-paths";
import { info, setLogLevel } from "../../lib/logger";
import { resolveAppWorkingDirectory, resolveWebRoot, resolveWorkspaceRoot } from "../../lib/runtime-paths";
import { PtydClient } from "../../ptyd/client";
import { loadConfig } from "../config/config";
import { loadExtensionConfig } from "../config/extension-config";
import { loadUiSettings } from "../config/ui-settings";
import type { BootstrapState } from "../model/bootstrap-state";
import { createFlmuxLastFile } from "../model/flmux-last";
import type { PropertyChangeEvent } from "../../types/property";
import type { HostPushMessage, HostPushPayload } from "../rpc/host-rpc";
import type { MainviewRpcSchema } from "../rpc/mainview-rpc";
import { type StartedAppRpcServer, startAppRpcServer } from "./app-rpc-server";
import { buildWebRenderer } from "./build-web-renderer";
import { probeCdpPort } from "./cdp-discovery";
import { buildExtensionSetups, discoverExtensions } from "./extension-discovery";
import { FlmuxLastStore } from "./flmux-last-store";
import { createHostRpcDispatcher } from "./host-rpc";
import { type PropertyStreamServer, startPropertyStreamServer } from "./property-stream";
import { resolveStartupOrphanPtydPolicy, resolveStartupSession } from "./ptyd-recovery";
import { RendererWorkspaceBridge } from "./renderer-workspace-bridge";
import { startWebServer } from "./web-server";
import { startWebUiServer, type WebUiServer } from "./web-ui-server";

export async function runAppMain(): Promise<void> {
  const config = loadConfig();
  const shouldRestore =
    config.app.restoreLayout && !process.argv.includes("--fresh") && process.env.FLMUX_FRESH !== "1";
  const startupResolution = await resolveStartupSession(async (orphans) => {
    const policy = resolveStartupOrphanPtydPolicy();
    if (policy !== "ask") {
      return policy;
    }
    return promptForOrphanPtydPolicy(orphans.length);
  });
  if (startupResolution.kind === "exit") {
    info("ptyd", startupResolution.reason);
    process.exit(2);
  }
  const sessionId = startupResolution.kind === "recover" ? startupResolution.sessionId : createSessionId();
  const flmuxLastStore = new FlmuxLastStore();
  const initialRestoreFile = shouldRestore ? await flmuxLastStore.load() : null;
  const workspaceCwd = resolveAppWorkingDirectory();
  const webRoot = resolveWebRoot();
  const appRpcIpcPath = getAppRpcIpcPath(sessionId);
  const propertyEventsIpcPath = getPropertyEventsIpcPath(sessionId);
  process.env.FLMUX_ROOT = workspaceCwd;
  setLogLevel(config.log.level);
  info("app", `starting session=${sessionId} root=${workspaceCwd}`);
  if (startupResolution.kind === "recover" && startupResolution.orphanCount > 0) {
    info("ptyd", `recovering orphan session ${startupResolution.sessionId}`);
  }
  if (startupResolution.kind === "fresh" && startupResolution.stoppedSessionIds.length > 0) {
    info("ptyd", `stopped orphan sessions: ${startupResolution.stoppedSessionIds.join(", ")}`);
  }
  let mainWindow: BrowserWindow;
  let appRpcServer: StartedAppRpcServer | null = null;
  let propertyStreamServer: PropertyStreamServer | null = null;
  let shuttingDown = false;
  const workspaceBridge = new RendererWorkspaceBridge(() => mainWindow);

  const webServer = startWebServer({ staticRoot: webRoot });
  const discoveredExtensions = discoverExtensions();
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
    extensionSetups: await buildExtensionSetups(discoveredExtensions),
    extensionConfig: loadExtensionConfig(),
    restoreLayout: shouldRestore,
    webServerUrl: webServer.url,
    uiTheme: loadUiSettings().theme,
    browserAutomation: {
      cdpBaseUrl: null
    }
  };

  const ptydClient = await PtydClient.start({
    sessionId,
    pushTerminalEvent: (event) => publishHostMessage("terminal.event", event)
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
      messages: {
        "workspace.props.changed": (event) => handlePropertyChange(event)
      }
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

  // Probe CDP port asynchronously and keep retrying for late-starting runtimes.
  void (async () => {
    const deadline = Date.now() + 30_000;
    while (!shuttingDown && Date.now() < deadline) {
      const cdpBaseUrl = await probeCdpPort();
      if (cdpBaseUrl) {
        bootstrapState.browserAutomation.cdpBaseUrl = cdpBaseUrl;
        workspaceBridge.setCdpBaseUrl(cdpBaseUrl);
        const propertyDeadline = Date.now() + 10_000;
        while (!shuttingDown && Date.now() < propertyDeadline) {
          try {
            await workspaceBridge.request("workspace.props.set", { scope: "app", key: "browser.cdpBaseUrl", value: cdpBaseUrl });
            break;
          } catch {
            await sleep(250);
          }
        }
        return;
      }
      await sleep(250);
    }
  })();

  appRpcServer = await startAppRpcServer({
    bridge: workspaceBridge,
    sessionId,
    workspaceRoot: workspaceCwd,
    ipcPath: appRpcIpcPath,
    pid: process.pid,
    platform: process.platform,
    requestQuit
  });
  propertyStreamServer = await startPropertyStreamServer(propertyEventsIpcPath);

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
      handleRendererRpc: () => {},
      handleRendererMessage: (message, payload) => {
        if (message === "workspace.props.changed") {
          handlePropertyChange(payload);
        }
      }
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

    if (propertyStreamServer) {
      await propertyStreamServer.stop();
      propertyStreamServer = null;
    }

    await ptydClient.dispose();
    await ptydClient.stopDaemon();
    webServer.stop();
    webUiServer?.stop();

    // Close window last — Electrobun exits the process when the last window
    // closes, so all cleanup must finish before this point.
    try {
      mainWindow.close();
    } catch {
      // best effort
    }
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

  function handlePropertyChange(event: PropertyChangeEvent): void {
    propertyStreamServer?.publish(event);
  }
}


async function promptForOrphanPtydPolicy(orphanCount: number): Promise<"recover" | "reset" | "exit"> {
  const recoverLabel = orphanCount === 1 ? "Recover Session" : "Recover Latest Session";
  const detail =
    orphanCount === 1
      ? "Recovering reconnects to the orphaned session. Start Fresh removes the orphan daemon and starts a new session."
      : "Recovering reconnects to the most recent orphaned session and removes the others. Start Fresh removes all orphan daemons and starts a new session.";

  const { response } = await Utils.showMessageBox({
    type: "question",
    title: "Orphan ptyd Detected",
    message:
      orphanCount === 1
        ? "A previous flmux terminal daemon is still running."
        : `${orphanCount} orphan flmux terminal daemons are still running.`,
    detail,
    buttons: [recoverLabel, "Start Fresh", "Exit"],
    defaultId: 0,
    cancelId: 2
  });

  return response === 0 ? "recover" : response === 1 ? "reset" : "exit";
}
