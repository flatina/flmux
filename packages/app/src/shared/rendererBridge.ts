import { call, defineCap, stream } from "bunite-core/rpc";
import type { ClientOf, ImplOf } from "bunite-core/rpc";
import type {
  AppStatusSnapshot,
  PathCallerContext,
  PathCallResult,
  PathGetResult,
  PathListResult,
  PathSetResult,
  SequencedShellCoreEvent,
  ShellPaneRecordSnapshot,
  WorkspaceStatusSnapshot
} from "@flmux/core/shell/types";
import type { FlmuxRuntimeMode } from "./runtimeMode";
import type { TerminalRuntimeEvent } from "@flmux/core/terminal/types";

export interface FlmuxShellSnapshot {
  app: AppStatusSnapshot;
  workspaces: WorkspaceStatusSnapshot[];
  panes: Record<string, ShellPaneRecordSnapshot[]>;
  paneParams: Record<string, Record<string, unknown> | undefined>;
  activeWorkspaceId: string | null;
}

export interface FlmuxShellBootstrapResponse {
  /** Opaque client identity. The renderer echoes this back in subsequent
   * pathCalls as `caller.clientId` so the core routes client-scoped
   * events + mutations to the right slot. Desktop CEF always receives
   * `"local"`; web clients get a server-minted id. */
  clientId: string;
  snapshot: FlmuxShellSnapshot;
  outerLayout: unknown | null;
  innerLayouts: Record<string, unknown | null>;
  seqStart: number;
}

export interface FlmuxSessionSaveLayouts {
  outerLayout: unknown | null;
  innerLayouts: Record<string, unknown | null>;
}

export interface FlmuxLocalExtensionLoadEntry {
  id: string;
  name: string;
  version: string;
  manifestUrl: string;
  rendererEntryUrl: string;
  // kind → fully-qualified icon URL (manifest `panes[].icon`). Empty when the extension declares no per-pane icons.
  paneIcons: Record<string, string>;
  // kind → manifest `panes[].defaultTitle`. Used for popup labels.
  paneDefaultTitles: Record<string, string>;
  // kind → manifest `panes[].minimumWidth`. Forwarded to dockview's panel constraint after `addPanel`.
  paneMinimumWidths: Record<string, number>;
  // kind → manifest `panes[].maximumWidth`. Forwarded to dockview's panel constraint after `addPanel`.
  paneMaximumWidths: Record<string, number>;
}

export interface FlmuxRendererBootstrapConfig {
  mode: FlmuxRuntimeMode;
  appOrigin: string;
  projectDir: string;
  authorityClientId: string | null;
  localExtensions: FlmuxLocalExtensionLoadEntry[];
  devMode: boolean;
}

export type ClientRegistrationResult = { status: "ok"; clientId: string } | { status: "rebootstrap-required" };

// Renderer's view of flmux. Same connection carries extension caps as siblings.
// `caller` is injected by trusted transports (preload + authenticated WS); HTTP
// callers cannot forge it — implicit-current narrowing handles them at the
// model layer.
export const shellCap = defineCap("flmux.shell", {
  get: call<{ path: string; caller?: PathCallerContext }, PathGetResult>(),
  list: call<{ path: string; caller?: PathCallerContext }, PathListResult>(),
  set: call<{ path: string; value: unknown; caller?: PathCallerContext }, PathSetResult>(),
  call: call<{ path: string; args?: Record<string, unknown>; caller?: PathCallerContext }, PathCallResult>(),

  events: stream<void, SequencedShellCoreEvent>(),
  terminalEvents: stream<{ paneId: string }, TerminalRuntimeEvent>(),

  bootstrap: call<void, FlmuxShellBootstrapResponse>(),
  registerClient: call<{ clientId?: string; lastAppliedSeq?: number }, ClientRegistrationResult>(),
  pushLayout: call<FlmuxSessionSaveLayouts, { ok: true }>(),
  getConfig: call<void, FlmuxRendererBootstrapConfig>()
});

export type ShellCapClient = ClientOf<typeof shellCap>;
export type ShellCapImpl = ImplOf<typeof shellCap>;

// HTTP envelopes deliberately omit `caller` — only preload + post-auth WS
// (which route through the connection setup) are trusted to inject caller
// context. External HTTP clients that try to forge clientId / sourcePaneId
// via the request body would otherwise bypass the implicit-current
// narrowing at the model layer.

export interface ClientScopedPathGetInput {
  authorityClientId: string;
  path: string;
}

export interface ClientScopedPathListInput {
  authorityClientId: string;
  path: string;
}

export interface ClientScopedPathSetInput {
  authorityClientId: string;
  path: string;
  value: unknown;
}

export interface ClientScopedPathCallInput {
  authorityClientId: string;
  path: string;
  args?: Record<string, unknown>;
}
