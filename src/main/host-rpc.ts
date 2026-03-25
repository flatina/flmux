import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserWindow } from "electrobun/bun";
import type { BootstrapState } from "../shared/bootstrap-state";
import {
  disableExtension,
  enableExtension,
  loadExtensionSettings,
  saveExtensionSettings
} from "../shared/extension-settings";
import type { FlmuxLastFile } from "../shared/flmux-last";
import type { HostRpcMethod, HostRpcParams, HostRpcResult } from "../shared/host-rpc";
import { debug, info } from "../shared/logger";
import { getSessionDir } from "../shared/paths";
import { saveUiTheme } from "../shared/ui-settings";
import {
  type DiscoveredExtension,
  discoverAllExtensions,
  EXTENSION_ID_PATTERN,
  loadExtensionSource
} from "./extension-discovery";
import type { FlmuxLastStore } from "./flmux-last-store";
import type { PtydClient } from "./ptyd-client";

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

export class HostRpcDispatcher {
  constructor(public readonly handlers: HostRpcHandlers) {}

  invoke(method: string, params: unknown): Promise<unknown> {
    if (!(method in this.handlers)) {
      return Promise.reject(new Error(`Unknown method: ${method}`));
    }

    const handler = this.handlers[method as HostRpcMethod] as (params: unknown) => Promise<unknown> | unknown;
    return Promise.resolve(handler(params));
  }
}

export function createHostRpcDispatcher(options: CreateHostRpcHandlersOptions): HostRpcDispatcher {
  return new HostRpcDispatcher(createHostRpcHandlers(options));
}

export function createHostRpcHandlers(options: CreateHostRpcHandlersOptions): HostRpcHandlers {
  return {
    "bootstrap.get": async () => options.bootstrapState,
    "flmuxLast.load": async () => ({
      file: await options.flmuxLastStore.load()
    }),
    "flmuxLast.save": async ({ file }) => {
      await options.flmuxLastStore.save(file);
      return { ok: true };
    },
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
    }),
    "extension.sourceLoad": async ({ extensionId }) => {
      info("ext", `load ${extensionId}`);
      return loadExtensionSource(options.discoveredExtensions, extensionId);
    },
    "extension.listAll": async () => ({
      extensions: discoverAllExtensions(options.workspaceRoot).map((ext) => ({
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
    "uiSettings.setTheme": async ({ theme }) => {
      if (!["system", "dark", "light"].includes(theme)) return { ok: true as const };
      saveUiTheme(theme);
      options.bootstrapState.uiTheme = theme;
      info("ui", `theme set to ${theme}`);
      return { ok: true as const };
    },
    "extension.uninstall": async ({ extensionId }) => {
      if (!EXTENSION_ID_PATTERN.test(extensionId)) return { ok: false as const, error: "Invalid extension ID" };

      const ext = discoverAllExtensions(options.workspaceRoot).find((entry) => entry.manifest.id === extensionId);
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
    },
    "fs.readDir": async ({ path, dirsOnly }) => ({
      entries: await readDirEntries(path, dirsOnly ?? false)
    }),
    "fs.readFile": async ({ path }) => {
      try {
        const content = await readFile(path, "utf-8");
        return { ok: true, content };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },
    "fs.writeFile": async ({ path, content }) => {
      try {
        await writeFile(path, content, "utf-8");
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },
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
    },
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
        webPort:
          webPort ??
          (options.bootstrapState.webServerUrl ? Number(new URL(options.bootstrapState.webServerUrl).port || 0) || null : null),
        startupCommands
      });
      options.syncTerminalBootstrapState();
      return result;
    },
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

async function readDirEntries(dirPath: string, dirsOnly: boolean): Promise<HostRpcResult<"fs.readDir">["entries"]> {
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
