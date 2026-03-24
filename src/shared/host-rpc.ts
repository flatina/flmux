import type { BootstrapState } from "./bootstrap-state";
import type { FlmuxLastFile, WindowFrame } from "./flmux-last";
import type { TerminalRuntimeId } from "./ids";
import type { TerminalRenderer } from "./pane-params";
import type { TerminalRuntimeEvent, TerminalRuntimeSummary } from "./rpc";

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
}

export interface HostRpcMethodMap {
  "bootstrap.get": {
    params: undefined;
    result: BootstrapState;
  };
  "flmuxLast.load": {
    params: undefined;
    result: { file: FlmuxLastFile | null };
  };
  "flmuxLast.save": {
    params: { file: FlmuxLastFile };
    result: { ok: true };
  };
  "session.save": {
    params: { name: string; file: FlmuxLastFile };
    result: { ok: true };
  };
  "session.load": {
    params: { name: string };
    result: { file: FlmuxLastFile | null };
  };
  "session.list": {
    params: undefined;
    result: { sessions: Array<{ name: string; savedAt: string }> };
  };
  "extension.sourceLoad": {
    params: { extensionId: string };
    result: { ok: true; source: string } | { ok: false; error: string };
  };
  "extension.listAll": {
    params: undefined;
    result: {
      extensions: Array<{
        id: string;
        name: string;
        version: string;
        embedded: boolean;
        disabled: boolean;
      }>;
    };
  };
  "extension.enable": {
    params: { extensionId: string };
    result: { ok: true };
  };
  "extension.disable": {
    params: { extensionId: string };
    result: { ok: true };
  };
  "extension.uninstall": {
    params: { extensionId: string };
    result: { ok: true } | { ok: false; error: string };
  };
  "fs.readDir": {
    params: { path: string; dirsOnly?: boolean };
    result: { entries: FsEntry[] };
  };
  "fs.readFile": {
    params: { path: string };
    result: { ok: true; content: string } | { ok: false; error: string };
  };
  "fs.writeFile": {
    params: { path: string; content: string };
    result: { ok: true } | { ok: false; error: string };
  };
  "window.minimize": {
    params: undefined;
    result: { ok: true };
  };
  "window.maximize": {
    params: undefined;
    result: { ok: true; maximized: boolean };
  };
  "window.close": {
    params: undefined;
    result: { ok: true };
  };
  "window.frame.get": {
    params: undefined;
    result: WindowFrame;
  };
  "window.frame.set": {
    params: WindowFrame;
    result: { ok: true };
  };
  "terminal.create": {
    params: {
      runtimeId: TerminalRuntimeId;
      paneId?: string | null;
      cwd?: string | null;
      shell?: string | null;
      renderer?: TerminalRenderer;
      cols?: number;
      rows?: number;
      workspaceRoot?: string | null;
    };
    result: {
      ok: true;
      created: boolean;
      terminal: TerminalRuntimeSummary;
    };
  };
  "terminal.kill": {
    params: { runtimeId: TerminalRuntimeId };
    result: {
      ok: true;
      runtimeId: TerminalRuntimeId;
      removed: boolean;
      exitCode: number | null;
    };
  };
  "terminal.input": {
    params: {
      runtimeId: TerminalRuntimeId;
      data: string;
    };
    result: {
      ok: true;
      accepted: boolean;
    };
  };
  "terminal.resize": {
    params: {
      runtimeId: TerminalRuntimeId;
      cols: number;
      rows: number;
    };
    result: {
      ok: true;
      terminal: TerminalRuntimeSummary | null;
    };
  };
  "terminal.history": {
    params: {
      runtimeId: TerminalRuntimeId;
      maxBytes?: number;
    };
    result: {
      ok: true;
      runtimeId: TerminalRuntimeId;
      data: string;
    };
  };
}

export interface HostPushMessageMap {
  "flmuxLast.changed": {
    file: FlmuxLastFile | null;
  };
  "terminal.event": TerminalRuntimeEvent;
}

export type HostRpcMethod = keyof HostRpcMethodMap;
export type HostRpcParams<Method extends HostRpcMethod> = HostRpcMethodMap[Method]["params"];
export type HostRpcResult<Method extends HostRpcMethod> = HostRpcMethodMap[Method]["result"];

export type HostPushMessage = keyof HostPushMessageMap;
export type HostPushPayload<Message extends HostPushMessage> = HostPushMessageMap[Message];

export interface HostRpc {
  request<Method extends HostRpcMethod>(method: Method, params: HostRpcParams<Method>): Promise<HostRpcResult<Method>>;
  subscribe?<Message extends HostPushMessage>(
    message: Message,
    handler: (payload: HostPushPayload<Message>) => void
  ): () => void;
}
