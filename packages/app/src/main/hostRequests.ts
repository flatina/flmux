import type { PathCallerContext } from "@flmux/core/shell";
import type {
  FlmuxRendererBootstrapConfig,
  FlmuxSessionSaveLayouts
} from "../shared/rendererBridge";
import type { FlmuxRuntimeMode } from "../shared/runtimeMode";
import type { DesktopShellAuthority } from "./desktopShellAuthority";
import type { FlmuxShellModelRouter } from "./shellModelBridge";
import type { TerminalService } from "./terminal-service";
import type { DiscoveredLocalExtension } from "./localExtensions";
import { createLocalExtensionLoadEntries } from "./localExtensions";

const TERMINAL_ATTACH_PATH = /^\/panes\/([^/]+)\/terminal\/attach$/;

export function createFlmuxHostRequestHandlers(options: {
  mode: FlmuxRuntimeMode;
  getAppOrigin(): string;
  getProjectDir(): string;
  getAuthorityClientId(): string | null;
  getCallerViewId(): number;
  /** Resolve the caller's attachmentId for a viewId; null before the
   * attachment forwarder has been installed. Injected into the
   * PathCallerContext of every `shellModel.path.call` so the core routes
   * attachment-scoped events and mutations to the right slot.
   * Optional — tests can omit (defaults to "no attachment", mutations land
   * on the authority's defaultSlotKey). */
  getCallerAttachmentId?(viewId: number): string | null;
  paneOwners: Map<string, number>;
  shellModelRouter: FlmuxShellModelRouter;
  terminalService: TerminalService;
  localExtensions: DiscoveredLocalExtension[];
  desktopAuthority: DesktopShellAuthority | null;
  onClientRegister?(viewId: number): void;
}) {
  const buildConfig = (): FlmuxRendererBootstrapConfig => ({
    mode: options.mode,
    appOrigin: options.getAppOrigin(),
    projectDir: options.getProjectDir(),
    authorityClientId: options.getAuthorityClientId(),
    localExtensions: createLocalExtensionLoadEntries(options.localExtensions, options.getAppOrigin())
  });

  const requireDesktopAuthority = (op: string): DesktopShellAuthority => {
    if (!options.desktopAuthority) {
      throw new Error(`${op} is only available in desktop mode`);
    }
    return options.desktopAuthority;
  };

  return {
    "flmux.getConfig": () => buildConfig(),

    "flmux.client.register": () => {
      const viewId = options.getCallerViewId();
      const registration = options.shellModelRouter.registerClient(viewId);
      options.onClientRegister?.(viewId);
      return registration;
    },

    "flmux.shellBootstrap": () => {
      return requireDesktopAuthority("flmux.shellBootstrap").shellBootstrap();
    },

    "flmux.session.save": async (params: FlmuxSessionSaveLayouts) => {
      await requireDesktopAuthority("flmux.session.save").persistSession(params);
      return { ok: true as const };
    },

    "shellModel.path.get": (params: { path: string }) => {
      return requireDesktopAuthority("shellModel.path.get").shellModel.pathGet(params.path);
    },

    "shellModel.path.list": (params: { path: string }) => {
      return requireDesktopAuthority("shellModel.path.list").shellModel.pathList(params.path);
    },

    "shellModel.path.set": (params: { path: string; value: unknown }) => {
      return requireDesktopAuthority("shellModel.path.set").shellModel.pathSet(params.path, params.value);
    },

    "shellModel.path.call": async (params: {
      path: string;
      args?: Record<string, unknown>;
      caller?: PathCallerContext;
    }) => {
      const authority = requireDesktopAuthority("shellModel.path.call");
      // Inject caller.attachmentId from the view's bound attachment so the
      // model layer can route slot-aware mutations (setActive*, createPane
      // with implicit ws, etc.) without relying on defaultSlotKey.
      const attachmentId = options.getCallerAttachmentId?.(options.getCallerViewId()) ?? null;
      const caller: PathCallerContext | undefined = attachmentId
        ? { ...(params.caller ?? {}), attachmentId: params.caller?.attachmentId ?? attachmentId }
        : params.caller;
      const result = await authority.shellModel.pathCall(params.path, params.args, caller);
      if (result.ok) {
        const attachMatch = TERMINAL_ATTACH_PATH.exec(params.path);
        if (attachMatch) {
          options.paneOwners.set(attachMatch[1], options.getCallerViewId());
        }
      }
      return result;
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
