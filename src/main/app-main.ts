import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserView, BrowserWindow } from "electrobun/bun";
import type { BootstrapState } from "../shared/bootstrap-state";
import { createFlmuxLastFile, type FlmuxLastFile } from "../shared/flmux-last";
import type { HostPushMessage, HostPushPayload, HostRpcParams } from "../shared/host-rpc";
import { createSessionId } from "../shared/ids";
import { getAppRpcIpcPath } from "../shared/ipc-paths";
import type { MainviewRpcSchema } from "../shared/mainview-rpc";
import { type StartedAppRpcServer, startAppRpcServer } from "./app-rpc-server";
import { probeCdpPort } from "./cdp-discovery";
import { loadConfig } from "./config-loader";
import { buildExtensionRegistry, discoverExtensions, loadExtensionSource } from "./extension-discovery";
import { FlmuxLastStore } from "./flmux-last-store";
import { debug, info, setLogLevel } from "../shared/logger";
import { PtydClient } from "./ptyd-client";
import { RendererWorkspaceBridge } from "./renderer-workspace-bridge";
import { getFlmuxDataDir } from "../shared/paths";
import { resolveAppWorkingDirectory, resolveWorkspaceRoot } from "./runtime-paths";
import { startWebServer } from "./web-server";
import { type WebUiServer, startWebUiServer } from "./web-ui-server";
import { buildWebRenderer } from "./build-web-renderer";

export async function runAppMain(): Promise<void> {
  const config = loadConfig();
  const shouldRestore =
    config.app.restoreLayout && !process.argv.includes("--fresh") && process.env.FLMUX_FRESH !== "1";
  const sessionId = createSessionId();
  const flmuxLastStore = new FlmuxLastStore();
  const initialRestoreFile = shouldRestore ? await flmuxLastStore.load() : null;
  const workspaceCwd = resolveAppWorkingDirectory();
  process.env.FLMUX_ROOT = workspaceCwd;
  setLogLevel(config.log.level);
  info("app", `starting session=${sessionId} root=${workspaceCwd}`);
  let mainWindow: BrowserWindow;
  let appRpcServer: StartedAppRpcServer | null = null;
  let shuttingDown = false;

  const webServer = startWebServer();
  const discoveredExtensions = discoverExtensions(workspaceCwd);
  if (discoveredExtensions.length > 0) {
    info("ext", `discovered ${discoveredExtensions.length}: ${discoveredExtensions.map((e) => e.manifest.id).join(", ")}`);
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
    push: publishHostMessage
  });
  info("ptyd", `connected terminals=${ptydClient.list().length}`);

  bootstrapState.liveTerminalRuntimes = ptydClient.list();
  bootstrapState.terminalRuntimeOwner = "ptyd";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hostRpcHandlers: Record<string, (params: any) => any> = {
        "bootstrap.get": async () => bootstrapState,
        "flmuxLast.load": async () => ({
          file: await flmuxLastStore.load()
        }),
        "flmuxLast.save": async ({ file }: { file: FlmuxLastFile }) => {
          await flmuxLastStore.save(file);
          return { ok: true };
        },
        "session.save": async ({ name, file }: { name: string; file: FlmuxLastFile }) => {
          const dir = join(getFlmuxDataDir(), "sessions");
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, `${sanitizeFileName(name)}.json`), JSON.stringify(file, null, 2), "utf-8");
          info("session", `saved "${name}"`);
          return { ok: true };
        },
        "session.load": async ({ name }: { name: string }) => {
          const path = join(getFlmuxDataDir(), "sessions", `${sanitizeFileName(name)}.json`);
          try {
            const raw = await readFile(path, "utf-8");
            return { file: JSON.parse(raw) as FlmuxLastFile };
          } catch {
            return { file: null };
          }
        },
        "session.list": async () => {
          const dir = join(getFlmuxDataDir(), "sessions");
          try {
            const files = await readdir(dir);
            const sessions = [];
            for (const f of files) {
              if (!f.endsWith(".json")) continue;
              try {
                const raw = await readFile(join(dir, f), "utf-8");
                const parsed = JSON.parse(raw) as FlmuxLastFile;
                sessions.push({ name: f.replace(/\.json$/, ""), savedAt: parsed.savedAt ?? "" });
              } catch { /* skip invalid */ }
            }
            sessions.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
            return { sessions };
          } catch {
            return { sessions: [] };
          }
        },
        "extension.sourceLoad": async ({ extensionId }: { extensionId: string }) => {
          info("ext", `load ${extensionId}`);
          return loadExtensionSource(discoveredExtensions, extensionId);
        },
        "fs.readDir": async ({ path, dirsOnly }: { path: string; dirsOnly?: boolean }) => ({
          entries: await readDirEntries(path, dirsOnly ?? false)
        }),
        "fs.readFile": async ({ path }: { path: string }) => {
          try {
            const content = await readFile(path, "utf-8");
            return { ok: true, content };
          } catch (error) {
            return { ok: false, error: String(error) };
          }
        },
        "fs.writeFile": async ({ path, content }: { path: string; content: string }) => {
          try {
            await writeFile(path, content, "utf-8");
            return { ok: true };
          } catch (error) {
            return { ok: false, error: String(error) };
          }
        },
        "fs.watch": async () => ({ ok: true }),
        "fs.unwatch": async () => ({ ok: true }),
        "window.minimize": async () => {
          mainWindow.minimize();
          return { ok: true };
        },
        "window.maximize": async () => {
          if (mainWindow.isMaximized()) {
            mainWindow.unmaximize();
            return { ok: true, maximized: false };
          }

          mainWindow.maximize();
          return { ok: true, maximized: true };
        },
        "window.close": async () => {
          mainWindow.close();
          return { ok: true };
        },
        "window.frame.get": async () => {
          const frame = mainWindow.getFrame();
          return {
            x: frame.x,
            y: frame.y,
            width: frame.width,
            height: frame.height,
            maximized: mainWindow.isMaximized()
          };
        },
        "window.frame.set": async ({
          x,
          y,
          width,
          height
        }: {
          x: number;
          y: number;
          width: number;
          height: number;
        }) => {
          mainWindow.setFrame(x, y, width, height);
          return { ok: true };
        },
        "terminal.create": async ({
          runtimeId,
          paneId,
          cwd,
          shell,
          renderer,
          cols,
          rows,
          workspaceRoot
        }: HostRpcParams<"terminal.create">) => {
          debug("term", `create runtime=${runtimeId} cwd=${cwd ?? workspaceCwd}`);
          const result = await ptydClient.createTerminal({
            runtimeId,
            paneId,
            cwd,
            shell,
            renderer,
            cols,
            rows,
            workspaceRoot: workspaceRoot ?? workspaceCwd
          });
          syncTerminalBootstrapState();
          return result;
        },
        "terminal.kill": async ({ runtimeId }: HostRpcParams<"terminal.kill">) => {
          debug("term", `kill runtime=${runtimeId}`);
          const result = await ptydClient.killTerminal({ runtimeId });
          syncTerminalBootstrapState();
          return result;
        },
        "terminal.input": async ({ runtimeId, data }: HostRpcParams<"terminal.input">) =>
          ptydClient.input({ runtimeId, data }),
        "terminal.resize": async ({ runtimeId, cols, rows }: HostRpcParams<"terminal.resize">) => {
          const result = await ptydClient.resize({
            runtimeId,
            cols,
            rows
          });
          syncTerminalBootstrapState();
          return result;
        },
        "terminal.history": async ({ runtimeId, maxBytes }: HostRpcParams<"terminal.history">) => {
          const result = await ptydClient.history({ runtimeId, maxBytes });
          return {
            ok: true,
            runtimeId: result.runtimeId,
            data: result.data
          };
        }
  };

  const rpc = BrowserView.defineRPC<MainviewRpcSchema>({
    maxRequestTime: 15_000,
    handlers: {
      requests: hostRpcHandlers as any,
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
    workspace: workspaceBridge,
    sessionId,
    workspaceRoot: workspaceCwd,
    ipcPath: getAppRpcIpcPath(workspaceCwd),
    pid: process.pid,
    platform: process.platform
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
      handleHostRpc: async (method, params) => {
        const handler = hostRpcHandlers[method];
        if (!handler) throw new Error(`Unknown method: ${method}`);
        return handler(params);
      },
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

    if (config.ptyd.stopOnExit) {
      await ptydClient.stopDaemon();
    }
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

async function readDirEntries(
  dirPath: string,
  dirsOnly: boolean
): Promise<
  Array<{
    name: string;
    path: string;
    isDir: boolean;
    size?: number;
  }>
> {
  const items = await readdir(dirPath, { withFileTypes: true });
  const entries = await Promise.all(
    items
      .filter((item) => !dirsOnly || item.isDirectory())
      .map(async (item) => {
        const itemPath = join(dirPath, item.name);
        if (item.isDirectory()) {
          return {
            name: item.name,
            path: itemPath,
            isDir: true
          };
        }

        const itemStat = await stat(itemPath);
        return {
          name: item.name,
          path: itemPath,
          isDir: false,
          size: itemStat.size
        };
      })
  );

  return entries.sort((left, right) => {
    if (left.isDir !== right.isDir) {
      return left.isDir ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
}

function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "unnamed";
}
