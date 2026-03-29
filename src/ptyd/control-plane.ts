import type { PtyDaemonId, SessionId, TerminalRuntimeId } from "../lib/ids";
import type { TerminalRenderer, TerminalRuntimeSummary } from "../types/terminal";

export const PTYD_PROTOCOL_VERSION = "4";

export interface PtydPingResult {
  pong: true;
}

export interface PtydIdentifyResult {
  app: "flmux-ptyd";
  daemonId: PtyDaemonId;
  sessionId: SessionId;
  pid: number;
  controlIpcPath: string;
  eventsIpcPath: string;
  startedAt: string;
  protocolVersion: string;
}

export interface PtydTerminalListResult {
  terminals: TerminalRuntimeSummary[];
}

export interface PtydDaemonStatusResult {
  ok: true;
  daemonId: PtyDaemonId;
  sessionId: SessionId;
  pid: number;
  controlIpcPath: string;
  eventsIpcPath: string;
  startedAt: string;
  protocolVersion: string;
  terminalCount: number;
}

export interface PtydTerminalCreateParams {
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
}

export interface PtydTerminalCreateResult {
  ok: true;
  created: boolean;
  terminal: TerminalRuntimeSummary;
}

export interface PtydTerminalKillParams {
  runtimeId: TerminalRuntimeId;
}

export interface PtydTerminalKillResult {
  ok: true;
  runtimeId: TerminalRuntimeId;
  removed: boolean;
  exitCode: number | null;
}

export interface PtydTerminalInputParams {
  runtimeId: TerminalRuntimeId;
  data: string;
}

export interface PtydTerminalInputResult {
  ok: true;
  accepted: boolean;
}

export interface PtydTerminalResizeParams {
  runtimeId: TerminalRuntimeId;
  cols: number;
  rows: number;
}

export interface PtydTerminalResizeResult {
  ok: true;
  terminal: TerminalRuntimeSummary | null;
}

export interface PtydTerminalHistoryParams {
  runtimeId: TerminalRuntimeId;
  maxBytes?: number;
}

export interface PtydTerminalHistoryResult {
  runtimeId: TerminalRuntimeId;
  data: string;
}

export interface PtydStopResult {
  ok: true;
}

export interface PtydMethodMap {
  "system.ping": {
    params: undefined;
    result: PtydPingResult;
  };
  "system.identify": {
    params: undefined;
    result: PtydIdentifyResult;
  };
  "terminal.list": {
    params: undefined;
    result: PtydTerminalListResult;
  };
  "terminal.create": {
    params: PtydTerminalCreateParams;
    result: PtydTerminalCreateResult;
  };
  "terminal.kill": {
    params: PtydTerminalKillParams;
    result: PtydTerminalKillResult;
  };
  "terminal.input": {
    params: PtydTerminalInputParams;
    result: PtydTerminalInputResult;
  };
  "terminal.resize": {
    params: PtydTerminalResizeParams;
    result: PtydTerminalResizeResult;
  };
  "terminal.history": {
    params: PtydTerminalHistoryParams;
    result: PtydTerminalHistoryResult;
  };
  "daemon.stop": {
    params: undefined;
    result: PtydStopResult;
  };
  "daemon.status": {
    params: undefined;
    result: PtydDaemonStatusResult;
  };
}

export type PtydMethod = keyof PtydMethodMap;
export type PtydParams<Method extends PtydMethod> = PtydMethodMap[Method]["params"];
export type PtydResult<Method extends PtydMethod> = PtydMethodMap[Method]["result"];
