import { Stream } from "bunite-core/rpc";
import type { ImplOf } from "bunite-core/rpc";
import {
  shellCap,
  type FlmuxRendererBootstrapConfig,
  type FlmuxSessionSaveLayouts
} from "../shared/rendererBridge";
import type {
  PathCallerContext,
  SequencedShellCoreEvent,
  ShellModelAPI
} from "@flmux/core/shell";
import type { TerminalRuntimeEvent } from "@flmux/core/terminal/types";
import { DESKTOP_CLIENT_ID, type DesktopShellAuthority } from "./desktopShellAuthority";
import type { FlmuxShellModelRouter } from "./shellModelBridge";

export interface ShellImplDeps {
  /** Per-connection caller viewId — desktop uses `view.webviewId`, web mints sequentially. */
  viewId: number;
  /** Live clientId for this connection, post-register. null before register. */
  getClientId(): string | null;
  /** Pane → set of stream emit callbacks. Replaces the old viewId-based paneSubscribers. */
  paneEmitters: Map<string, Set<(event: TerminalRuntimeEvent) => void>>;
  /** Resolve the shellModel for this connection — desktop ignores hints, web uses clientId binding. */
  resolveShellModel(hints?: { clientId?: string }): ShellModelAPI | null;
  /** Resolve the shellModel router for register-time clientId minting. */
  resolveShellModelRouter(hints?: { clientId?: string }): FlmuxShellModelRouter | null;
  /** ACL gate for `terminalEvents({paneId})` — deny if the pane is not owned
   * by the caller's authority (web multi-user). Desktop returns true. */
  canSubscribeTerminalForPane(paneId: string): boolean;
  /** Renderer init config. */
  buildConfig(): FlmuxRendererBootstrapConfig;
  /** Desktop-only — null in web mode. */
  desktopAuthority: DesktopShellAuthority | null;
  /** Wire viewId → clientId after registerClient, install live event
   *  forwarder. Cap registration already happened synchronously at
   *  connection setup, so this is just the per-client binding + buffer
   *  subscriber install. */
  onClientRegister?(binding?: { clientId: string; lastAppliedSeq: number }): "rebootstrap-required" | void;
  /** Subscribe to shellCore events for this client (buffered + live, with ACL gating). */
  subscribeShellEvents(clientId: string, sinceSeq: number, emit: (event: SequencedShellCoreEvent) => void): () => void;
  /** Layout save callback for `pushLayout` — debounced by authority. */
  pushLayout?(layouts: FlmuxSessionSaveLayouts): void;
}

export function createShellImpl(deps: ShellImplDeps): ImplOf<typeof shellCap> {
  function resolvePreloadCaller(incoming?: PathCallerContext): PathCallerContext | undefined {
    const clientId = deps.getClientId();
    if (!clientId) return incoming;
    // Connection-bound clientId always wins — RPC arg is untrusted (renderer
    // could otherwise forge slot identity for implicit-current narrowing).
    return { ...(incoming ?? {}), clientId };
  }

  function requireShellModel(op: string): ShellModelAPI {
    const shellModel = deps.resolveShellModel();
    if (!shellModel) throw new Error(`${op}: no authority resolvable for caller (client not bound)`);
    return shellModel;
  }

  return {
    get: ({ path, caller }) => {
      const shellModel = requireShellModel("shell.get");
      return shellModel.pathGet(path, resolvePreloadCaller(caller));
    },

    list: ({ path, caller }) => {
      const shellModel = requireShellModel("shell.list");
      return shellModel.pathList(path, resolvePreloadCaller(caller));
    },

    set: ({ path, value, caller }) => {
      const shellModel = requireShellModel("shell.set");
      return shellModel.pathSet(path, value, resolvePreloadCaller(caller));
    },

    call: async ({ path, args, caller }) => {
      const shellModel = requireShellModel("shell.call");
      return shellModel.pathCall(path, args, resolvePreloadCaller(caller));
    },

    events: () => Stream.from<SequencedShellCoreEvent>((emit, signal) => {
      const clientId = deps.getClientId();
      if (!clientId) {
        throw new Error("shell.events requires a registered client; call shell.registerClient first");
      }
      const unsub = deps.subscribeShellEvents(clientId, 0, emit);
      signal.addEventListener("abort", unsub);
    }),

    terminalEvents: ({ paneId }) => Stream.from<TerminalRuntimeEvent>((emit, signal) => {
      if (!deps.canSubscribeTerminalForPane(paneId)) {
        throw new Error(`shell.terminalEvents: access denied for pane '${paneId}'`);
      }
      let emitters = deps.paneEmitters.get(paneId);
      if (!emitters) {
        emitters = new Set();
        deps.paneEmitters.set(paneId, emitters);
      }
      emitters.add(emit);
      signal.addEventListener("abort", () => {
        const set = deps.paneEmitters.get(paneId);
        if (!set) return;
        set.delete(emit);
        if (set.size === 0) deps.paneEmitters.delete(paneId);
      });
    }),

    bootstrap: () => {
      if (!deps.desktopAuthority) {
        throw new Error("shell.bootstrap is only available in desktop mode (web uses HTTP /api/shell/bootstrap)");
      }
      return deps.desktopAuthority.shellBootstrap(DESKTOP_CLIENT_ID);
    },

    registerClient: ({ clientId, lastAppliedSeq }) => {
      const binding = clientId ? { clientId, lastAppliedSeq: lastAppliedSeq ?? 0 } : undefined;
      const router = deps.resolveShellModelRouter(binding);
      if (!router) {
        if (binding) return { status: "rebootstrap-required" as const };
        throw new Error("shell.registerClient: no authority resolvable for caller");
      }
      const resolvedClientId = binding?.clientId ?? DESKTOP_CLIENT_ID;
      const registration = router.registerClient(deps.viewId, resolvedClientId);
      const outcome = deps.onClientRegister?.(binding);
      if (outcome === "rebootstrap-required") return { status: "rebootstrap-required" as const };
      return { status: "ok" as const, clientId: registration.clientId };
    },

    pushLayout: (layouts) => {
      deps.pushLayout?.(layouts);
      return { ok: true as const };
    },

    getConfig: () => deps.buildConfig()
  };
}
