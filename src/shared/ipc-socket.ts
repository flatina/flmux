import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

export function isNamedPipePath(ipcPath: string): boolean {
  return ipcPath.startsWith("\\\\.");
}

export async function prepareIpcListenerPath(ipcPath: string): Promise<void> {
  if (isNamedPipePath(ipcPath)) {
    return;
  }

  await mkdir(dirname(ipcPath), { recursive: true });
  await rm(ipcPath, { force: true });
}

export async function cleanupIpcListenerPath(ipcPath: string): Promise<void> {
  if (isNamedPipePath(ipcPath)) {
    return;
  }

  await rm(ipcPath, { force: true });
}
