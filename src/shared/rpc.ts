import type { TerminalRuntimeId } from "./ids";

export interface RpcEndpoint {
  ipcPath: string;
}

export type TerminalRuntimeStatus = "running" | "exited";

export interface TerminalRuntimeSummary {
  runtimeId: TerminalRuntimeId;
  cwd: string | null;
  shell: string | null;
  startedAt: string;
  status: TerminalRuntimeStatus;
  exitCode: number | null;
  cols: number;
  rows: number;
}

export type TerminalRuntimeEvent =
  | {
      type: "state";
      runtime: TerminalRuntimeSummary;
    }
  | {
      type: "output";
      runtimeId: TerminalRuntimeId;
      data: string;
    }
  | {
      type: "removed";
      runtimeId: TerminalRuntimeId;
      exitCode: number | null;
    };
