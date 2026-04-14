import type { RPCTransport } from "bunite-core/shared/rpc";
import type {
  PathCallResult,
  PathGetResult,
  PathListResult,
  PathSetResult
} from "../renderer/shell/types";
import type { TerminalRuntimeEvent } from "./terminal";

export type RendererShellModelRequestMap = Record<string, { params: unknown; response: unknown }> & {
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

export type FlmuxRendererBridgeSchema = {
  bun: {
    requests: {};
    messages: {
      "terminal.event": TerminalRuntimeEvent;
    };
  };
  webview: {
    requests: RendererShellModelRequestMap;
    messages: {};
  };
};

export interface RendererShellModelBridge {
  setTransport(transport: RPCTransport): void;
  sendProxy: {
    "terminal.event": (payload: TerminalRuntimeEvent) => void;
  };
  requestProxy: {
    [K in keyof RendererShellModelRequestMap]: (
      params: RendererShellModelRequestMap[K]["params"]
    ) => Promise<RendererShellModelRequestMap[K]["response"]>;
  };
}

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
