import { tmpdir } from "node:os";
import { join } from "node:path";

export function getPtydControlIpcPath(rootKey: string) {
  return resolveIpcPath(`flmux-ptyd-${rootKey}-control`);
}

export function getPtydEventsIpcPath(rootKey: string) {
  return resolveIpcPath(`flmux-ptyd-${rootKey}-events`);
}

function resolveIpcPath(name: string) {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\${name}`;
  }

  return join(tmpdir(), `${name}.sock`);
}
