import { callJsonRpcIpc } from "../../src/main/ptyd/jsonRpcIpc";
import { PtydLockFile, type PtydLockEntry } from "../../src/main/ptyd/lockFile";
import { waitFor } from "./waitFor";

export async function loadPtydLockForRootDir(rootDir: string): Promise<PtydLockEntry | null> {
  return new PtydLockFile(rootDir).load();
}

export async function stopOwnedPtydDaemonsForRootDir(rootDir: string) {
  const lockFile = new PtydLockFile(rootDir);
  const lock = await lockFile.load();
  if (!lock) return;

  try {
    await callJsonRpcIpc(lock.controlIpcPath, "daemon.stop", undefined, 2_000);
  } catch {}

  try {
    await waitFor(async () => ((await lockFile.load()) ? null : true), { timeoutMs: 5_000, intervalMs: 200 });
  } catch {
    await lockFile.clear();
  }
}
