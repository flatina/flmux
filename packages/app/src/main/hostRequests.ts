import type { FlmuxRendererBootstrapConfig } from "../shared/rendererBridge";
import type { FlmuxRuntimeMode } from "../shared/runtimeMode";
import { isSessionSnapshot, type FlmuxSessionStore } from "./sessionStore";
import type { FlmuxShellModelRouter } from "./shellModelBridge";
import type { TerminalService } from "./terminal-service";
import type { DiscoveredLocalExtension } from "./localExtensions";
import { createLocalExtensionLoadEntries } from "./localExtensions";

export function createFlmuxHostRequestHandlers(options: {
  mode: FlmuxRuntimeMode;
  getAppOrigin(): string;
  getProjectDir(): string;
  getAuthorityClientId(): string | null;
  getCallerViewId(): number;
  paneOwners: Map<string, number>;
  shellModelRouter: FlmuxShellModelRouter;
  terminalService: TerminalService;
  localExtensions: DiscoveredLocalExtension[];
  sessionStore: FlmuxSessionStore | null;
}) {
  const buildConfig = (): FlmuxRendererBootstrapConfig => ({
    mode: options.mode,
    appOrigin: options.getAppOrigin(),
    projectDir: options.getProjectDir(),
    authorityClientId: options.getAuthorityClientId(),
    localExtensions: createLocalExtensionLoadEntries(options.localExtensions, options.getAppOrigin())
  });

  return {
    "flmux.getConfig": () => buildConfig(),

    "flmux.client.register": () => {
      return options.shellModelRouter.registerClient(options.getCallerViewId());
    },

    "flmux.session.load": () => {
      return options.sessionStore?.load() ?? null;
    },

    "flmux.session.save": async (params: unknown) => {
      if (!options.sessionStore) {
        throw new Error("Session persistence is only available in desktop mode");
      }
      if (!isSessionSnapshot(params)) {
        throw new Error("Invalid flmux session snapshot");
      }

      await options.sessionStore.save(params);
      return { ok: true as const };
    },

    "flmux.terminal.create": async (params: Parameters<TerminalService["create"]>[0]) => {
      if (params.paneId) {
        options.paneOwners.set(params.paneId, options.getCallerViewId());
      }
      return options.terminalService.create(params);
    },

    "flmux.terminal.adopt": async (params: Parameters<TerminalService["adoptByPaneId"]>[0]) => {
      const result = await options.terminalService.adoptByPaneId(params);
      if (result.outcome === "adopted") {
        options.paneOwners.set(params.paneId, options.getCallerViewId());
      }
      return result;
    },

    "flmux.terminal.write": (params: Parameters<TerminalService["write"]>[0]) => {
      return options.terminalService.write(params);
    },

    "flmux.terminal.resize": (params: Parameters<TerminalService["resize"]>[0]) => {
      return options.terminalService.resize(params);
    },

    "flmux.terminal.history": (params: Parameters<TerminalService["history"]>[0]) => {
      return options.terminalService.history(params);
    },

    "flmux.terminal.kill": (params: Parameters<TerminalService["kill"]>[0]) => {
      return options.terminalService.kill(params);
    },

    "flmux.terminal.listRoots": () => {
      return options.terminalService.listRoots();
    }
  };
}
