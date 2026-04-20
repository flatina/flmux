import type { RPCSchema } from "bunite-core";
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
} from "../renderer/shell/types";
import type { FlmuxRuntimeMode } from "./runtimeMode";
import type {
  TerminalAdoptResult,
  TerminalCreateInput,
  TerminalCreateResult,
  TerminalHistoryResult,
  TerminalKillResult,
  TerminalResizeResult,
  TerminalRootStatus,
  TerminalRuntimeEvent,
  TerminalWriteResult
} from "./terminal";

export interface FlmuxShellSnapshot {
  app: AppStatusSnapshot;
  workspaces: WorkspaceStatusSnapshot[];
  panes: Record<string, ShellPaneRecordSnapshot[]>;
  paneParams: Record<string, Record<string, unknown> | undefined>;
  activeWorkspaceId: string | null;
}

export interface FlmuxShellBootstrapResponse {
  /** Opaque attachment identity. Client echoes this back in subsequent
   * pathCalls as `caller.attachmentId` so the core routes attachment-scoped
   * events + mutations to the right slot. Desktop CEF always receives
   * `"local"`; web attachments get a server-minted id. */
  attachmentId: string;
  snapshot: FlmuxShellSnapshot;
  outerLayout: unknown | null;
  innerLayouts: Record<string, unknown | null>;
  seqStart: number;
}

export interface FlmuxSessionSaveLayouts {
  outerLayout: unknown | null;
  innerLayouts: Record<string, unknown | null>;
}

// ── Host requests (renderer calls main) ──
//
// See internal docs — only `shellModel.path.*` mirrors to HTTP.
// Other members (`flmux.*`) are preload-only; adding new RPCs defaults to
// preload-only unless they slot into the ShellModelAPI path surface.
//

export interface FlmuxLocalExtensionLoadEntry {
  id: string;
  name: string;
  version: string;
  manifestUrl: string;
  rendererEntryUrl: string;
}

export interface FlmuxRendererBootstrapConfig {
  mode: FlmuxRuntimeMode;
  appOrigin: string;
  projectDir: string;
  authorityClientId: string | null;
  localExtensions: FlmuxLocalExtensionLoadEntry[];
}

export type FlmuxHostRequests = {
  "flmux.getConfig": {
    params: undefined;
    response: FlmuxRendererBootstrapConfig;
  };
  "flmux.client.register": {
    params: { attachmentId?: string; lastAppliedSeq?: number };
    response: ClientRegistrationResult;
  };
  "flmux.layout.push": {
    params: FlmuxSessionSaveLayouts;
    response: { ok: true };
  };
  "flmux.terminal.create": {
    params: TerminalCreateInput;
    response: TerminalCreateResult;
  };
  "flmux.terminal.adopt": {
    params: { rootDir: string; paneId: string };
    response: TerminalAdoptResult;
  };
  "flmux.terminal.write": {
    params: { rootKey: string; runtimeId: string; data: string };
    response: TerminalWriteResult;
  };
  "flmux.terminal.resize": {
    params: { rootKey: string; runtimeId: string; cols: number; rows: number };
    response: TerminalResizeResult;
  };
  "flmux.terminal.history": {
    params: { rootKey: string; runtimeId: string; maxBytes?: number };
    response: TerminalHistoryResult;
  };
  "flmux.terminal.kill": {
    params: { rootKey: string; runtimeId: string };
    response: TerminalKillResult;
  };
  "flmux.terminal.listRoots": {
    params: undefined;
    response: TerminalRootStatus[];
  };
  "flmux.shellBootstrap": {
    params: undefined;
    response: FlmuxShellBootstrapResponse;
  };
  "shellModel.path.get": {
    params: { path: string; caller?: PathCallerContext };
    response: PathGetResult;
  };
  "shellModel.path.list": {
    params: { path: string; caller?: PathCallerContext };
    response: PathListResult;
  };
  "shellModel.path.set": {
    params: { path: string; value: unknown; caller?: PathCallerContext };
    response: PathSetResult;
  };
  "shellModel.path.call": {
    params: { path: string; args?: Record<string, unknown>; caller?: PathCallerContext };
    response: PathCallResult;
  };
};

// ── Host messages (main pushes to renderer) ──

export type FlmuxHostMessages = {
  "terminal.event": TerminalRuntimeEvent;
  "shellCore.event": SequencedShellCoreEvent;
};

// ── RPC schema ──

export type FlmuxRendererBridgeSchema = {
  bun: RPCSchema<{
    requests: FlmuxHostRequests;
    messages: FlmuxHostMessages;
  }>;
  webview: RPCSchema<{}>;
};

// ── Host request proxy (used by renderer to call main) ──

export type FlmuxHostRequestProxy = {
  [K in keyof FlmuxHostRequests]: (
    ...args: undefined extends FlmuxHostRequests[K]["params"]
      ? [params?: FlmuxHostRequests[K]["params"]]
      : [params: FlmuxHostRequests[K]["params"]]
  ) => Promise<FlmuxHostRequests[K]["response"]>;
};

// ── Bridge interface (used by main to push messages to renderer) ──

export interface FlmuxRendererBridge {
  sendProxy: {
    "terminal.event": (payload: TerminalRuntimeEvent) => void;
    "shellCore.event": (payload: SequencedShellCoreEvent) => void;
  };
}

// ── Shared types ──

export type ClientRegistrationResult =
  | { status: "ok"; clientId: string }
  | { status: "rebootstrap-required" };

// HTTP envelopes deliberately omit `caller` — only preload + post-auth WS
// (which route through `hostRequests.ts`) are trusted to inject caller
// context. External HTTP clients that try to forge attachmentId /
// sourcePaneId via the request body would otherwise bypass the
// implicit-current narrowing at the model layer.

export interface ClientScopedPathGetInput {
  clientId: string;
  path: string;
}

export interface ClientScopedPathListInput {
  clientId: string;
  path: string;
}

export interface ClientScopedPathSetInput {
  clientId: string;
  path: string;
  value: unknown;
}

export interface ClientScopedPathCallInput {
  clientId: string;
  path: string;
  args?: Record<string, unknown>;
}
