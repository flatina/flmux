import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserWindow } from "electrobun/bun";
import type { BootstrapState } from "../model/bootstrap-state";
import type { FlmuxLastFile } from "../model/flmux-last";
import type { HostRpcMethod, HostRpcParams, HostRpcResult } from "../rpc/host-rpc";
import type { DiscoveredExtension } from "./extension-discovery";
import { discoverAllExtensions, EXTENSION_ID_PATTERN, loadExtensionText } from "./extension-discovery";
import type { FlmuxLastStore } from "./flmux-last-store";
import type { PtydClient } from "../../ptyd/client";
import { RpcDispatcher } from "../../lib/rpc";
import { loadExtensionSettings, saveExtensionSettings, enableExtension, disableExtension } from "../config/extension-settings";
import { saveUiTheme } from "../config/ui-settings";
import { debug, info } from "../../lib/logger";
import { getSessionDir } from "../../lib/paths";

export type HostRpcHandlers = {
  [Method in HostRpcMethod]: (params: HostRpcParams<Method>) => Promise<HostRpcResult<Method>> | HostRpcResult<Method>;
};

export interface CreateHostRpcHandlersOptions {
  bootstrapState: BootstrapState;
  flmuxLastStore: FlmuxLastStore;
  workspaceRoot: string;
  discoveredExtensions: DiscoveredExtension[];
  ptydClient: PtydClient;
  getMainWindow: () => BrowserWindow;
  requestQuit: () => void;
  syncTerminalBootstrapState: () => void;
}

export function createHostRpcDispatcher(options: CreateHostRpcHandlersOptions): RpcDispatcher<HostRpcHandlers> {
  return new RpcDispatcher(createHostRpcHandlers(options));
}

function createHostRpcHandlers(options: CreateHostRpcHandlersOptions): HostRpcHandlers {
  return {
    "bootstrap.get": async () => options.bootstrapState,
    ...createFlmuxLastHandlers(options),
    ...createSessionHandlers(),
    ...createExtensionHandlers(options),
    ...createUiHandlers(options),
    ...createWindowHandlers(options),
    ...createTerminalHandlers(options)
  };
}

function createFlmuxLastHandlers(
  options: CreateHostRpcHandlersOptions
): Pick<HostRpcHandlers, "flmuxLast.load" | "flmuxLast.save"> {
  return {
    "flmuxLast.load": async () => ({
      file: await options.flmuxLastStore.load()
    }),
    "flmuxLast.save": async ({ file }) => {
      await options.flmuxLastStore.save(file);
      return { ok: true };
    }
  };
}

function createSessionHandlers(): Pick<HostRpcHandlers, "session.save" | "session.load" | "session.list"> {
  return {
    "session.save": async ({ name, file }) => {
      await saveNamedSession(name, file);
      info("session", `saved "${name}"`);
      return { ok: true };
    },
    "session.load": async ({ name }) => ({
      file: await loadNamedSession(name)
    }),
    "session.list": async () => ({
      sessions: await listNamedSessions()
    })
  };
}

function createExtensionHandlers(
  options: CreateHostRpcHandlersOptions
): Pick<
  HostRpcHandlers,
  "extension.textLoad" | "extension.listAll" | "extension.enable" | "extension.disable" | "extension.uninstall"
> {
  return {
    "extension.textLoad": async (params) => {
      info("ext", params.kind === "renderer" ? `load ${params.extensionId}` : `asset ${params.extensionId}:${params.path}`);
      return loadExtensionText(options.discoveredExtensions, params);
    },
    "extension.listAll": async () => ({
      extensions: discoverAllExtensions().map((ext) => ({
        id: ext.manifest.id,
        name: ext.manifest.name,
        version: ext.manifest.version,
        embedded: ext.embedded,
        disabled: ext.disabled
      }))
    }),
    "extension.enable": async ({ extensionId }) => {
      if (!EXTENSION_ID_PATTERN.test(extensionId)) return { ok: true as const };
      const settings = loadExtensionSettings();
      saveExtensionSettings(enableExtension(settings, extensionId));
      info("ext", `enabled ${extensionId}`);
      return { ok: true as const };
    },
    "extension.disable": async ({ extensionId }) => {
      if (!EXTENSION_ID_PATTERN.test(extensionId)) return { ok: true as const };
      const settings = loadExtensionSettings();
      saveExtensionSettings(disableExtension(settings, extensionId));
      info("ext", `disabled ${extensionId}`);
      return { ok: true as const };
    },
    "extension.uninstall": async ({ extensionId }) => {
      if (!EXTENSION_ID_PATTERN.test(extensionId)) return { ok: false as const, error: "Invalid extension ID" };

      const ext = discoverAllExtensions().find((entry) => entry.manifest.id === extensionId);
      if (!ext) return { ok: false as const, error: `Extension not found: ${extensionId}` };
      if (ext.embedded) return { ok: false as const, error: "Cannot uninstall built-in extension" };

      const { rmSync } = await import("node:fs");
      try {
        rmSync(ext.path, { recursive: true, force: true });
        const settings = loadExtensionSettings();
        saveExtensionSettings(enableExtension(settings, extensionId));
        info("ext", `uninstalled ${extensionId}`);
        return { ok: true as const };
      } catch (error) {
        return { ok: false as const, error: `Failed to uninstall: ${error}` };
      }
    }
  };
}

function createUiHandlers(options: CreateHostRpcHandlersOptions): Pick<HostRpcHandlers, "uiSettings.setTheme"> {
  return {
    "uiSettings.setTheme": async ({ theme }) => {
      if (!["system", "dark", "light"].includes(theme)) return { ok: true as const };
      saveUiTheme(theme);
      options.bootstrapState.uiTheme = theme;
      info("ui", `theme set to ${theme}`);
      return { ok: true as const };
    }
  };
}

function createWindowHandlers(
  options: CreateHostRpcHandlersOptions
): Pick<HostRpcHandlers, "window.minimize" | "window.maximize" | "window.close" | "window.frame.get" | "window.frame.set"> {
  return {
    "window.minimize": async () => {
      options.getMainWindow().minimize();
      return { ok: true };
    },
    "window.maximize": async () => {
      const window = options.getMainWindow();
      if (window.isMaximized()) {
        window.unmaximize();
        return { ok: true, maximized: false };
      }

      window.maximize();
      return { ok: true, maximized: true };
    },
    "window.close": async () => {
      options.requestQuit();
      return { ok: true };
    },
    "window.frame.get": async () => {
      const window = options.getMainWindow();
      const frame = window.getFrame();
      return {
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
        maximized: window.isMaximized()
      };
    },
    "window.frame.set": async ({ x, y, width, height }) => {
      options.getMainWindow().setFrame(x, y, width, height);
      return { ok: true };
    }
  };
}

function createTerminalHandlers(
  options: CreateHostRpcHandlersOptions
): Pick<HostRpcHandlers, "terminal.create" | "terminal.get" | "terminal.kill" | "terminal.input" | "terminal.resize" | "terminal.history"> {
  return {
    "terminal.create": async ({ runtimeId, paneId, cwd, shell, renderer, cols, rows, workspaceRoot, webPort, startupCommands }) => {
      debug("term", `create runtime=${runtimeId} cwd=${cwd ?? options.workspaceRoot}`);
      const result = await options.ptydClient.createTerminal({
        runtimeId,
        paneId,
        cwd,
        shell,
        renderer,
        cols,
        rows,
        workspaceRoot: workspaceRoot ?? options.workspaceRoot,
        webPort: webPort ?? getWebPort(options.bootstrapState.webServerUrl),
        startupCommands
      });
      options.syncTerminalBootstrapState();
      return result;
    },
    "terminal.get": async ({ runtimeId }) => ({
      runtime: options.ptydClient.list().find((runtime) => runtime.runtimeId === runtimeId) ?? null
    }),
    "terminal.kill": async ({ runtimeId }) => {
      debug("term", `kill runtime=${runtimeId}`);
      const result = await options.ptydClient.killTerminal({ runtimeId });
      options.syncTerminalBootstrapState();
      return result;
    },
    "terminal.input": async ({ runtimeId, data }) => options.ptydClient.input({ runtimeId, data }),
    "terminal.resize": async ({ runtimeId, cols, rows }) => {
      const result = await options.ptydClient.resize({ runtimeId, cols, rows });
      options.syncTerminalBootstrapState();
      return result;
    },
    "terminal.history": async ({ runtimeId, maxBytes }) => {
      const result = await options.ptydClient.history({ runtimeId, maxBytes });
      return {
        ok: true,
        runtimeId: result.runtimeId,
        data: result.data
      };
    }
  };
}

function getWebPort(webServerUrl: string | null): number | null {
  if (!webServerUrl) {
    return null;
  }
  return Number(new URL(webServerUrl).port || 0) || null;
}

async function saveNamedSession(name: string, file: FlmuxLastFile): Promise<void> {
  const sessionsDir = getSessionDir();
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(sessionsDir, `${sanitizeFileName(name)}.json`), JSON.stringify(file, null, 2), "utf-8");
}

async function loadNamedSession(name: string): Promise<FlmuxLastFile | null> {
  try {
    const raw = await readFile(join(getSessionDir(), `${sanitizeFileName(name)}.json`), "utf-8");
    return JSON.parse(raw) as FlmuxLastFile;
  } catch {
    return null;
  }
}

async function listNamedSessions(): Promise<Array<{ name: string; savedAt: string }>> {
  try {
    const files = await readdir(getSessionDir());
    const sessions: Array<{ name: string; savedAt: string }> = [];
    for (const fileName of files) {
      if (!fileName.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(getSessionDir(), fileName), "utf-8");
        const parsed = JSON.parse(raw) as FlmuxLastFile;
        sessions.push({ name: fileName.replace(/\.json$/, ""), savedAt: parsed.savedAt ?? "" });
      } catch {
        // skip invalid session files
      }
    }
    sessions.sort((left, right) => right.savedAt.localeCompare(left.savedAt));
    return sessions;
  } catch {
    return [];
  }
}

function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "unnamed";
}
