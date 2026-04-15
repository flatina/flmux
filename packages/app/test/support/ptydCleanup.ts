import { callJsonRpcIpc } from "../../src/main/ptyd/jsonRpcIpc";
import { PtydLockFile } from "../../src/main/ptyd/lockFile";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeTerminalRootDir } from "../../src/shared/terminalPath";
import { waitFor } from "./waitFor";

export interface OwnedPtydLock {
  rootKey: string;
  controlIpcPath: string;
}

export async function findOwnedPtydLocksForRootDir(
  rootDir: string,
  options: { directory?: string } = {}
): Promise<OwnedPtydLock[]> {
  const directory = options.directory ?? tmpdir();
  const expectedRootDir = normalizeForRootCompare(rootDir);
  const entries = await readdir(directory, { withFileTypes: true });
  const locks: OwnedPtydLock[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("flmux-ptyd-root_") || !entry.name.endsWith(".lock")) {
      continue;
    }

    try {
      const raw = await Bun.file(join(directory, entry.name)).text();
      const parsed = JSON.parse(raw) as {
        rootKey?: string;
        rootDir?: string;
        controlIpcPath?: string;
      };
      if (
        typeof parsed.rootKey !== "string" ||
        typeof parsed.rootDir !== "string" ||
        typeof parsed.controlIpcPath !== "string"
      ) {
        continue;
      }

      if (normalizeForRootCompare(parsed.rootDir) !== expectedRootDir) {
        continue;
      }

      locks.push({
        rootKey: parsed.rootKey,
        controlIpcPath: parsed.controlIpcPath
      });
    } catch {}
  }

  return locks;
}

export async function stopOwnedPtydDaemonsForRootDir(rootDir: string) {
  const ownedLocks = await findOwnedPtydLocksForRootDir(rootDir);
  await Promise.all(ownedLocks.map((lock) => stopPtydDaemonLock(lock)));
}

export async function stopPtydDaemonLock(lock: OwnedPtydLock) {
  try {
    await callJsonRpcIpc(lock.controlIpcPath, "daemon.stop", undefined, 2_000);
  } catch {}

  const lockFile = new PtydLockFile(lock.rootKey);
  try {
    await waitFor(
      async () => ((await lockFile.load()) ? null : true),
      { timeoutMs: 5_000, intervalMs: 200 }
    );
  } catch {
    await lockFile.clear();
  }
}

function normalizeForRootCompare(rootDir: string) {
  const normalized = normalizeTerminalRootDir(rootDir);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
