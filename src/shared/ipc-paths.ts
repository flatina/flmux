import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function normalizeWorkspaceRoot(workspaceRoot: string): string {
  const normalized = workspaceRoot.replace(/[\\/]+/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function getWorkspaceKey(workspaceRoot: string): string {
  return createHash("sha256").update(normalizeWorkspaceRoot(workspaceRoot)).digest("hex").slice(0, 16);
}

export function getAppRpcIpcPath(workspaceRoot: string): string {
  return resolveIpcPath(`flmux-app-${getWorkspaceKey(workspaceRoot)}`);
}

export function getPtydControlIpcPath(workspaceRoot: string): string {
  return resolveIpcPath(`flmux-ptyd-${getWorkspaceKey(workspaceRoot)}-control`);
}

export function getPtydEventsIpcPath(workspaceRoot: string): string {
  return resolveIpcPath(`flmux-ptyd-${getWorkspaceKey(workspaceRoot)}-events`);
}

function resolveIpcPath(name: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\${name}`;
  }

  return join(tmpdir(), `${name}.sock`);
}
