import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { toTerminalRootKey } from "../rootKey";

export interface PtydLockEntry {
  daemonId: string;
  pid: number;
  rootKey: string;
  rootDir: string;
  controlIpcPath: string;
  eventsIpcPath: string;
  startedAt: string;
  protocolVersion: string;
}

/**
 * Lock file location: `<rootDir>/.flmux/tmp/ptyd.lock`. Sits under `tmp/`
 * because it's truly ephemeral (cleared on clean daemon shutdown) and
 * safe to wipe at any time — the daemon will recreate it on restart.
 * Scoping to rootDir means stale locks die with their rootDir: when a
 * test's `mkdtemp` dir is removed or an install is wiped, the lock goes
 * too, so there's no tmpdir-wide accumulation across sessions.
 */
export function getPtydLockPath(rootDir: string) {
  return join(rootDir, ".flmux", "tmp", "ptyd.lock");
}

export class PtydLockFile {
  readonly filePath: string;
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.filePath = getPtydLockPath(rootDir);
  }

  async load(): Promise<PtydLockEntry | null> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isPtydLockEntry(parsed)) return null;
      const expected = toTerminalRootKey(this.rootDir);
      if (parsed.rootKey !== expected) {
        // `.flmux/` is keyed to an absolute install path — moving the tree
        // invalidates the lock's rootKey. Treat as stale so a fresh daemon
        // spawns under the new rootKey; adoption cannot carry across moves.
        console.warn(
          `[ptyd] lock at ${this.filePath} has stale rootKey '${parsed.rootKey}'; expected '${expected}'. Ignoring — adoption will not carry.`
        );
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async write(entry: PtydLockEntry): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(entry, null, 2), "utf8");
  }

  async clear(): Promise<void> {
    try {
      await rm(this.filePath, { force: true });
    } catch {}
  }

  async clearIfOwned(owner: { daemonId: string; pid: number }): Promise<void> {
    const current = await this.load();
    if (!current) {
      return;
    }

    if (current.daemonId !== owner.daemonId || current.pid !== owner.pid) {
      return;
    }

    await this.clear();
  }
}

function isPtydLockEntry(value: unknown): value is PtydLockEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as Partial<PtydLockEntry>;
  return (
    typeof entry.daemonId === "string" &&
    typeof entry.pid === "number" &&
    typeof entry.rootKey === "string" &&
    typeof entry.rootDir === "string" &&
    typeof entry.controlIpcPath === "string" &&
    typeof entry.eventsIpcPath === "string" &&
    typeof entry.startedAt === "string" &&
    typeof entry.protocolVersion === "string"
  );
}
