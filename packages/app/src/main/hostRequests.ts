import type { PathCallerContext, ShellModelAPI } from "@flmux/core/shell";
import type { FlmuxRendererBootstrapConfig, FlmuxSessionSaveLayouts } from "../shared/rendererBridge";
import type { FlmuxRuntimeMode } from "../shared/runtimeMode";
import { DESKTOP_CLIENT_ID, type DesktopShellAuthority } from "./desktopShellAuthority";
import type { FlmuxShellModelRouter } from "./shellModelBridge";
import type { DiscoveredLocalExtension } from "./localExtensions";
import { createLocalExtensionLoadEntries } from "./localExtensions";

const TERMINAL_ATTACH_PATH = /^\/panes\/([^/]+)\/terminal\/attach$/;

export function createFlmuxHostRequestHandlers(options: {
  mode: FlmuxRuntimeMode;
  getAppOrigin(): string;
  getProjectDir(): string;
  getAuthorityClientId(): string | null;
  getCallerViewId(): number;
  /** Resolve the caller's clientId for a viewId; null before the
   * client forwarder has been installed. Injected into the
   * PathCallerContext of every `shellModel.path.call` so the core routes
   * client-scoped events and mutations to the right slot.
   * Optional — tests can omit (defaults to "no client", mutations land
   * on the authority's defaultSlotKey). */
  getCallerClientId?(viewId: number): string | null;
  /** Pane → set of subscribed viewIds. Terminal events fan out to every
   * subscriber. See `main.ts` for the shared instance and `releaseView`
   * cleanup path. */
  paneSubscribers: Map<string, Set<number>>;
  /** Resolve the caller's authority `ShellModelAPI`. Desktop ignores args
   * and returns the single authority; web needs the caller's client
   * binding (`viewId` for post-register calls, or `hints.clientId`
   * during register itself when `viewIdToClientId` isn't set yet).
   * Throws the RPC back to the client if the binding can't be resolved
   * (should be impossible for well-behaved clients). */
  resolveShellModel(viewId: number, hints?: { clientId?: string }): ShellModelAPI | null;
  /** Resolve the caller's `FlmuxShellModelRouter` — used for clientId
   * minting at register time. Same input shape as `resolveShellModel`. */
  resolveShellModelRouter(viewId: number, hints?: { clientId?: string }): FlmuxShellModelRouter | null;
  localExtensions: DiscoveredLocalExtension[];
  desktopAuthority: DesktopShellAuthority | null;
  /** Bind a freshly-registered view to its client. Returning
   * `"rebootstrap-required"` short-circuits the RPC with the same status,
   * telling the client to drop local state and re-POST `/api/shell/bootstrap`.
   * Desktop ignores `binding`; web passes `{clientId, lastAppliedSeq}`
   * after the HTTP bootstrap response. */
  onClientRegister?(
    viewId: number,
    binding?: { clientId: string; lastAppliedSeq: number }
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
    localExtensions: createLocalExtensionLoadEntries(options.localExtensions, options.getAppOrigin()),
    devMode: process.env.FLMUX_DEV_MODE === "1"
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
      throw new Error(`${op}: no authority resolvable for caller (client not bound)`);
    }
    return shellModel;
  };

  const resolvePreloadCaller = (incoming?: PathCallerContext): PathCallerContext | undefined => {
    const clientId = options.getCallerClientId?.(options.getCallerViewId()) ?? null;
    if (!clientId) return incoming;
    return { ...(incoming ?? {}), clientId: incoming?.clientId ?? clientId };
  };

  return {
    "flmux.getConfig": () => buildConfig(),

    "flmux.client.register": (params: { clientId?: string; lastAppliedSeq?: number }) => {
      const viewId = options.getCallerViewId();
      const binding = params?.clientId
        ? {
            clientId: params.clientId,
            lastAppliedSeq: params.lastAppliedSeq ?? 0
          }
        : undefined;
      // Resolve the caller's router from the binding hint. When the
      // client is unknown server-side (aged out during grace, never
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
      // Bind viewId to the supplied clientId — desktop pins `DESKTOP_CLIENT_ID`,
      // web carries the bootstrap-minted clientId via the binding payload.
      // `onClientRegister` then installs the forwarder.
      const clientId = binding?.clientId ?? DESKTOP_CLIENT_ID;
      const registration = router.registerClient(viewId, clientId);
      const outcome = options.onClientRegister?.(viewId, binding);
      if (outcome === "rebootstrap-required") {
        return { status: "rebootstrap-required" as const };
      }
      return { status: "ok" as const, clientId: registration.clientId };
    },

    "flmux.shellBootstrap": () => {
      // Desktop CEF pins `"local"` as its client. Web clients receive
      // their server-minted `clientId` via `/api/shell/bootstrap` HTTP
      // POST instead — they never reach this preload-only RPC.
      return requireDesktopAuthority("flmux.shellBootstrap").shellBootstrap(DESKTOP_CLIENT_ID);
    },

    "flmux.layout.push": (params: FlmuxSessionSaveLayouts) => {
      options.pushLayout?.(options.getCallerViewId(), params);
      return { ok: true as const };
    },

    // Inject caller.clientId from the view's bound client on every
    // shellModel.path.* RPC so the model layer can route slot-aware reads
    // (/status/workspace/*) and mutations (setActive*, createPane with
    // implicit ws, etc.) without relying on defaultSlotKey.
    "shellModel.path.get": (params: { path: string; caller?: PathCallerContext }) => {
      const shellModel = requireShellModel("shellModel.path.get");
      return shellModel.pathGet(params.path, resolvePreloadCaller(params.caller));
    },

    "shellModel.path.list": (params: { path: string; caller?: PathCallerContext }) => {
      const shellModel = requireShellModel("shellModel.path.list");
      return shellModel.pathList(params.path, resolvePreloadCaller(params.caller));
    },

    "shellModel.path.set": (params: { path: string; value: unknown; caller?: PathCallerContext }) => {
      const shellModel = requireShellModel("shellModel.path.set");
      return shellModel.pathSet(params.path, params.value, resolvePreloadCaller(params.caller));
    },

    "shellModel.path.call": async (params: {
      path: string;
      args?: Record<string, unknown>;
      caller?: PathCallerContext;
    }) => {
      // Pre-subscribe for terminal/attach so terminal events emitted
      // mid-attach are routed to the caller's viewId instead of dropped.
      // Roll back on failure — but only if we were the one that added
      // the membership, so a transient failure from an already-subscribed
      // viewId (e.g. retry) doesn't silently drop fan-out.
      // Narrow race remains: output events that fire between the
      // server's history snapshot (idempotent branch) and the RPC
      // response are re-written by the renderer's `applyAttachResult`
      // when it resets xterm to the snapshot. Fixing requires a
      // sequencing cursor — out of scope for D1.
      const attachMatch = TERMINAL_ATTACH_PATH.exec(params.path);
      const viewId = options.getCallerViewId();
      let attachAddedSubscriber = false;
      if (attachMatch) {
        const paneId = attachMatch[1]!;
        attachAddedSubscriber = !options.paneSubscribers.get(paneId)?.has(viewId);
        addPaneSubscriber(options.paneSubscribers, paneId, viewId);
      }
      try {
        const shellModel = requireShellModel("shellModel.path.call");
        const result = await shellModel.pathCall(params.path, params.args, resolvePreloadCaller(params.caller));
        if (attachMatch && attachAddedSubscriber && !result.ok) {
          removePaneSubscriber(options.paneSubscribers, attachMatch[1]!, viewId);
        }
        return result;
      } catch (error) {
        if (attachMatch && attachAddedSubscriber) {
          removePaneSubscriber(options.paneSubscribers, attachMatch[1]!, viewId);
        }
        throw error;
      }
    }
  };
}

function addPaneSubscriber(map: Map<string, Set<number>>, paneId: string, viewId: number): void {
  let set = map.get(paneId);
  if (!set) {
    set = new Set();
    map.set(paneId, set);
  }
  set.add(viewId);
}

function removePaneSubscriber(map: Map<string, Set<number>>, paneId: string, viewId: number): void {
  const set = map.get(paneId);
  if (!set) return;
  set.delete(viewId);
  if (set.size === 0) map.delete(paneId);
}
