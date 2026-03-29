import type { BootstrapState } from "../model/bootstrap-state";
import type { FlmuxLastFile, WindowFrame } from "../model/flmux-last";
import type { TerminalRuntimeId } from "../../lib/ids";
import type { TerminalRenderer } from "../model/pane-params";
import type { TerminalRuntimeEvent, TerminalRuntimeSummary } from "../../types/terminal";
import type { ThemePreference } from "../../types/view";

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
  "extension.textLoad": {
    params:
      | { extensionId: string; kind: "renderer" }
      | { extensionId: string; kind: "asset"; path: string };
    result: { ok: true; content: string } | { ok: false; error: string };
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
  "fs.readFile": {
    params: { path: string };
    result: { ok: true; content: string } | { ok: false; error: string };
  };
  "fs.writeFile": {
    params: { path: string; content: string };
    result: { ok: true } | { ok: false; error: string };
  };
  "fs.readDir": {
    params: { path: string };
    result: {
      ok: true;
      entries: Array<{ name: string; path: string; isDir: boolean; size?: number }>;
    } | { ok: false; error: string };
  };
  "uiSettings.setTheme": {
    params: { theme: ThemePreference };
    result: { ok: true };
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
      webPort?: number | null;
      startupCommands?: string[];
    };
    result: {
      ok: true;
      created: boolean;
      terminal: TerminalRuntimeSummary;
    };
  };
  "terminal.get": {
    params: {
      runtimeId: TerminalRuntimeId;
    };
    result: {
      runtime: TerminalRuntimeSummary | null;
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
