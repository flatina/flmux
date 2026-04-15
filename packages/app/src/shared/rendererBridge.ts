import type { RPCSchema } from "bunite-core";
import type {
  PathCallResult,
  PathGetResult,
  PathListResult,
  PathSetResult
} from "../renderer/shell/types";
import type { FlmuxSessionSnapshot } from "./session";
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

// ── Host requests (renderer calls main) ──

export interface FlmuxLocalExtensionLoadEntry {
  id: string;
  name: string;
  version: string;
  manifestUrl: string;
  rendererEntryUrl: string;
}

export interface FlmuxRendererBootstrapConfig {
  appOrigin: string;
  projectDir: string;
  localExtensions: FlmuxLocalExtensionLoadEntry[];
}

export type FlmuxHostRequests = {
  "flmux.getConfig": {
    params: undefined;
    response: FlmuxRendererBootstrapConfig;
  };
  "flmux.client.register": {
    params: undefined;
    response: ClientRegistrationResult;
  };
  "flmux.session.load": {
    params: undefined;
    response: FlmuxSessionSnapshot | null;
  };
  "flmux.session.save": {
    params: FlmuxSessionSnapshot;
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
};

// ── Host messages (main pushes to renderer) ──

export type FlmuxHostMessages = {
  "terminal.event": TerminalRuntimeEvent;
};

// ── Shell model requests (main calls renderer) ──

export type FlmuxRendererRequests = {
  "shellModel.path.get": {
    params: { path: string };
    response: PathGetResult;
  };
  "shellModel.path.list": {
    params: { path: string };
    response: PathListResult;
  };
  "shellModel.path.set": {
    params: { path: string; value: unknown };
    response: PathSetResult;
  };
  "shellModel.path.call": {
    params: { path: string; args?: Record<string, unknown> };
    response: PathCallResult;
  };
};

// ── RPC schema ──

export type FlmuxRendererBridgeSchema = {
  bun: RPCSchema<{
    requests: FlmuxHostRequests;
    messages: FlmuxHostMessages;
  }>;
  webview: RPCSchema<{
    requests: FlmuxRendererRequests;
  }>;
};

// ── Host request proxy (used by renderer to call main) ──

export type FlmuxHostRequestProxy = {
  [K in keyof FlmuxHostRequests]: (
    ...args: undefined extends FlmuxHostRequests[K]["params"]
      ? [params?: FlmuxHostRequests[K]["params"]]
      : [params: FlmuxHostRequests[K]["params"]]
  ) => Promise<FlmuxHostRequests[K]["response"]>;
};

// ── Bridge interface (used by main to interact with renderer) ──

export interface FlmuxRendererBridge {
  sendProxy: {
    "terminal.event": (payload: TerminalRuntimeEvent) => void;
  };
  requestProxy: {
    [K in keyof FlmuxRendererRequests]: (
      params: FlmuxRendererRequests[K]["params"]
    ) => Promise<FlmuxRendererRequests[K]["response"]>;
  };
}

// ── Shared types ──

export interface ClientRegistrationResult {
  clientId: string;
}

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
