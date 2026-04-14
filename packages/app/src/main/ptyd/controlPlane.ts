import type {
  TerminalCreateInput,
  TerminalCreateResult,
  TerminalHistoryResult,
  TerminalKillResult,
  TerminalRootStatus,
  TerminalRuntimeSummary,
  TerminalWriteResult
} from "../../shared/terminal";

export const PTYD_PROTOCOL_VERSION = "1";

export interface PtydIdentifyResult {
  app: "flmux-ptyd";
  daemonId: string;
  pid: number;
  rootKey: string;
  rootDir: string;
  controlIpcPath: string;
  eventsIpcPath: string;
  startedAt: string;
  protocolVersion: string;
}

export interface PtydDaemonStatusResult {
  ok: true;
  daemonId: string;
  pid: number;
  rootKey: string;
  rootDir: string;
  controlIpcPath: string;
  eventsIpcPath: string;
  startedAt: string;
  protocolVersion: string;
  terminalCount: number;
}

export interface PtydTerminalRecord extends TerminalRuntimeSummary {
  ownerPaneId: string | null;
}

export interface PtydTerminalListResult {
  terminals: PtydTerminalRecord[];
}

export interface PtydTerminalCreateParams extends TerminalCreateInput {
  runtimeId: string;
}

export interface PtydTerminalCreateResult extends TerminalCreateResult {}

export interface PtydTerminalInputParams {
  runtimeId: string;
  data: string;
}

export interface PtydTerminalInputResult extends TerminalWriteResult {}

export interface PtydTerminalHistoryParams {
  runtimeId: string;
  maxBytes?: number;
}

export interface PtydTerminalHistoryResult extends TerminalHistoryResult {}

export interface PtydTerminalKillParams {
  runtimeId: string;
}

export interface PtydTerminalKillResult extends TerminalKillResult {}

export interface PtydPingResult {
  pong: true;
}

export interface PtydStopResult {
  ok: true;
}

export type PtydTerminalEvent =
  | { type: "state"; terminal: TerminalRuntimeSummary }
  | { type: "output"; runtimeId: string; data: string }
  | { type: "removed"; runtimeId: string };

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
  "terminal.input": {
    params: PtydTerminalInputParams;
    result: PtydTerminalInputResult;
  };
  "terminal.history": {
    params: PtydTerminalHistoryParams;
    result: PtydTerminalHistoryResult;
  };
  "terminal.kill": {
    params: PtydTerminalKillParams;
    result: PtydTerminalKillResult;
  };
  "daemon.stop": {
    params: undefined;
    result: PtydStopResult;
  };
  "daemon.status": {
    params: undefined;
    result: PtydDaemonStatusResult;
  };
  "root.status": {
    params: undefined;
    result: TerminalRootStatus;
  };
}

export type PtydMethod = keyof PtydMethodMap;
export type PtydParams<M extends PtydMethod> = PtydMethodMap[M]["params"];
export type PtydResult<M extends PtydMethod> = PtydMethodMap[M]["result"];
