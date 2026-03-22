import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PtyDaemonId } from "../shared/ids";
import { getWorkspaceKey, normalizeWorkspaceRoot } from "../shared/ipc-paths";

export interface PtydLockEntry {
  daemonId: PtyDaemonId;
  workspaceRoot: string;
  pid: number;
  controlIpcPath: string;
  eventsIpcPath: string;
  startedAt: string;
  protocolVersion: string;
}

export class PtydLockFile {
  readonly filePath: string;

  constructor(workspaceRoot: string) {
    this.filePath = resolvePtydLockPath(workspaceRoot);
  }

  async load(): Promise<PtydLockEntry | null> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return isPtydLockEntry(parsed) ? parsed : null;
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
    } catch {
      // best effort cleanup
    }
  }

  async clearIfOwned(owner: { daemonId: PtyDaemonId; pid: number }): Promise<void> {
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

function resolvePtydLockPath(workspaceRoot: string): string {
  return join(tmpdir(), `flmux-ptyd-${getWorkspaceKey(workspaceRoot)}.lock`);
}

function isPtydLockEntry(value: unknown): value is PtydLockEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as Partial<PtydLockEntry>;
  return (
    typeof entry.daemonId === "string" &&
    typeof entry.workspaceRoot === "string" &&
    typeof entry.pid === "number" &&
    entry.workspaceRoot === normalizeWorkspaceRoot(entry.workspaceRoot) &&
    typeof entry.controlIpcPath === "string" &&
    typeof entry.eventsIpcPath === "string" &&
    typeof entry.startedAt === "string" &&
    typeof entry.protocolVersion === "string"
  );
}
