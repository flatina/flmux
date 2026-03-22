import type { SessionId } from "./ids";

export interface SessionRecord {
  app: "flmux";
  sessionId: SessionId;
  workspaceRoot: string;
  pid: number;
  ipcPath: string;
  startedAt: string;
}

export function isSessionRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<SessionRecord>;
  return (
    record.app === "flmux" &&
    typeof record.sessionId === "string" &&
    typeof record.workspaceRoot === "string" &&
    typeof record.pid === "number" &&
    typeof record.ipcPath === "string" &&
    typeof record.startedAt === "string"
  );
}
