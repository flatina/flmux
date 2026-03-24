import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionId } from "./ids";

export function getAppRpcIpcPath(sessionId: SessionId | string): string {
  return resolveIpcPath(`flmux-app-${sessionId}`);
}

export function getPtydControlIpcPath(sessionId: SessionId | string): string {
  return resolveIpcPath(`flmux-ptyd-${sessionId}-control`);
}

export function getPtydEventsIpcPath(sessionId: SessionId | string): string {
  return resolveIpcPath(`flmux-ptyd-${sessionId}-events`);
}

function resolveIpcPath(name: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\${name}`;
  }

  return join(tmpdir(), `${name}.sock`);
}
