import type { PathCallerContext, ShellModelAPI } from "@flmux/core/shell";
import type {
  FlmuxRendererBootstrapConfig,
  FlmuxSessionSaveLayouts
} from "../shared/rendererBridge";
import type { FlmuxRuntimeMode } from "../shared/runtimeMode";
import { DESKTOP_ATTACHMENT_ID, type DesktopShellAuthority } from "./desktopShellAuthority";
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
  /** Resolve the caller's authority `ShellModelAPI`. Desktop ignores args
   * and returns the single authority; web needs the caller's attachment
   * binding (`viewId` for post-register calls, or `hints.attachmentId`
   * during register itself when `viewIdToAttachmentId` isn't set yet).
   * Throws the RPC back to the client if the binding can't be resolved
   * (should be impossible for well-behaved clients). */
  resolveShellModel(viewId: number, hints?: { attachmentId?: string }): ShellModelAPI | null;
  /** Resolve the caller's `FlmuxShellModelRouter` — used for clientId
   * minting at register time. Same input shape as `resolveShellModel`. */
  resolveShellModelRouter(viewId: number, hints?: { attachmentId?: string }): FlmuxShellModelRouter | null;
  terminalService: TerminalService;
  localExtensions: DiscoveredLocalExtension[];
  desktopAuthority: DesktopShellAuthority | null;
  /** Bind a freshly-registered view to its attachment. Returning
   * `"rebootstrap-required"` short-circuits the RPC with the same status,
   * telling the client to drop local state and re-POST `/api/shell/bootstrap`.
   * Desktop ignores `binding`; web passes `{attachmentId, lastAppliedSeq}`
   * after the HTTP bootstrap response. */
  onClientRegister?(
    viewId: number,
    binding?: { attachmentId: string; lastAppliedSeq: number }
  ): "rebootstrap-required" | void;
  /** Record a layout delta for the main-side debounced session write.
   * `viewId` is the caller's renderer id — main resolves which user's
   * authority owns the save (per-user sessionStore in web, single
   * sessionStore in desktop). A no-op when the authority has no
   * `persistSession` wired. */
  pushLayout?(viewId: number, layouts: FlmuxSessionSaveLayouts): void;
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

  const requireShellModel = (op: string): ShellModelAPI => {
    const shellModel = options.resolveShellModel(options.getCallerViewId());
    if (!shellModel) {
      throw new Error(`${op}: no authority resolvable for caller (attachment not bound)`);
    }
    return shellModel;
  };

  return {
    "flmux.getConfig": () => buildConfig(),

    "flmux.client.register": (params: {
      attachmentId?: string;
      lastAppliedSeq?: number;
    }) => {
      const viewId = options.getCallerViewId();
      const binding = params?.attachmentId
        ? {
            attachmentId: params.attachmentId,
            lastAppliedSeq: params.lastAppliedSeq ?? 0
          }
        : undefined;
      // Resolve the caller's router from the binding hint. When the
      // attachment is unknown server-side (aged out during grace, never
      // minted, or the client replayed a stale/bogus id), the web resolver
      // returns null — signal `rebootstrap-required` so the client recovers
      // via HTTP bootstrap instead of surfacing a raw RPC error. Desktop
      // ignores the binding and always returns its single authority; a
      // null here means a genuine misconfiguration.
      const router = options.resolveShellModelRouter(viewId, binding);
      if (!router) {
        if (binding) {
          return { status: "rebootstrap-required" as const };
        }
        throw new Error("flmux.client.register: no authority resolvable for caller");
      }
      // Mint clientId first — `onClientRegister` installs the forwarder which
      // may resolve the client by viewId (requires a minted id). On
      // "rebootstrap-required" the dangling clientId is cleaned up when the
      // client closes its WS to re-bootstrap.
      const registration = router.registerClient(viewId);
      const outcome = options.onClientRegister?.(viewId, binding);
      if (outcome === "rebootstrap-required") {
        return { status: "rebootstrap-required" as const };
      }
      return { status: "ok" as const, clientId: registration.clientId };
    },

    "flmux.shellBootstrap": () => {
      // Desktop CEF pins `"local"` as its attachment. Web clients receive
      // their server-minted `attachmentId` via `/api/shell/bootstrap` HTTP
      // POST instead — they never reach this preload-only RPC.
      return requireDesktopAuthority("flmux.shellBootstrap").shellBootstrap(DESKTOP_ATTACHMENT_ID);
    },

    "flmux.layout.push": (params: FlmuxSessionSaveLayouts) => {
      options.pushLayout?.(options.getCallerViewId(), params);
      return { ok: true as const };
    },

    "shellModel.path.get": (params: { path: string }) => {
      const shellModel = requireShellModel("shellModel.path.get");
      return shellModel.pathGet(params.path);
    },

    "shellModel.path.list": (params: { path: string }) => {
      const shellModel = requireShellModel("shellModel.path.list");
      return shellModel.pathList(params.path);
    },

    "shellModel.path.set": (params: { path: string; value: unknown }) => {
      const shellModel = requireShellModel("shellModel.path.set");
      return shellModel.pathSet(params.path, params.value);
    },

    "shellModel.path.call": async (params: {
      path: string;
      args?: Record<string, unknown>;
      caller?: PathCallerContext;
    }) => {
      const shellModel = requireShellModel("shellModel.path.call");
      // Inject caller.attachmentId from the view's bound attachment so the
      // model layer can route slot-aware mutations (setActive*, createPane
      // with implicit ws, etc.) without relying on defaultSlotKey.
      const attachmentId = options.getCallerAttachmentId?.(options.getCallerViewId()) ?? null;
      const caller: PathCallerContext | undefined = attachmentId
        ? { ...(params.caller ?? {}), attachmentId: params.caller?.attachmentId ?? attachmentId }
        : params.caller;
      const result = await shellModel.pathCall(params.path, params.args, caller);
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
