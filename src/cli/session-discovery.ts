import { readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SystemIdentifyResult } from "../shared/app-rpc";
import type { SessionId } from "../shared/ids";
import { getAppRpcIpcPath } from "../shared/ipc-paths";
import { callJsonRpcIpc } from "../shared/json-rpc-ipc";
import { PTYD_PROTOCOL_VERSION, type PtydIdentifyResult } from "../shared/ptyd-control-plane";
import { isRpcEndpointReachable } from "./rpc-client";

const PTYD_LOCK_PREFIX = "flmux-ptyd-";
const PTYD_LOCK_SUFFIX = ".lock";

interface PtydLockSnapshot {
  sessionId: SessionId;
  controlIpcPath: string;
  startedAt: string;
  lockPath: string;
}

export interface DiscoveredSession {
  app: "flmux";
  sessionId: SessionId;
  workspaceRoot: string;
  pid: number;
  ipcPath: string;
  startedAt: string;
  reachable: boolean;
}

export interface RecoverablePtydSession {
  sessionId: SessionId;
  controlIpcPath: string;
  startedAt: string;
}

export async function listSessions(): Promise<DiscoveredSession[]> {
  const locks = await listLivePtydLocks();
  const discovered = await Promise.all(
    locks.map(async (lock) => {
      const ipcPath = getAppRpcIpcPath(lock.sessionId);
      const reachable = await isRpcEndpointReachable({ ipcPath });
      if (!reachable) {
        return null;
      }

      const identify = await identifyApp(ipcPath);
      if (!identify) {
        return null;
      }

      return {
        app: "flmux" as const,
        sessionId: identify.sessionId,
        workspaceRoot: identify.workspaceRoot,
        pid: identify.pid,
        ipcPath,
        startedAt: lock.startedAt,
        reachable: true
      };
    })
  );

  return discovered
    .filter((session): session is DiscoveredSession => session !== null)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export async function listRecoverablePtydSessions(): Promise<RecoverablePtydSession[]> {
  const locks = await listLivePtydLocks();
  const liveSessions = new Set((await listSessions()).map((session) => session.sessionId));

  return locks
    .filter((lock) => !liveSessions.has(lock.sessionId))
    .map((lock) => ({
      sessionId: lock.sessionId,
      controlIpcPath: lock.controlIpcPath,
      startedAt: lock.startedAt
    }))
    .sort((left, right) => bcmp(right.startedAt, left.startedAt));
}

export async function resolveSession(sessionId?: SessionId | string): Promise<DiscoveredSession> {
  const sessions = await listSessions();
  if (sessions.length === 0) {
    throw new Error("No running flmux sessions found.");
  }

  if (sessionId) {
    const session = sessions.find((entry) => entry.sessionId === sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return session;
  }

  return sessions[0]!;
}

export async function cleanupStaleSessions(): Promise<{ removed: string[]; kept: string[] }> {
  const entries = await scanPtydLockEntries();
  const removed: string[] = [];
  const kept: string[] = [];

  for (const entry of entries) {
    const identified = await identifyPtyd(entry.controlIpcPath);
    if (!identified || identified.protocolVersion !== PTYD_PROTOCOL_VERSION) {
      await removeLockPath(entry.lockPath);
      removed.push(entry.sessionId);
    } else {
      kept.push(entry.sessionId);
    }
  }

  return { removed, kept };
}

async function listLivePtydLocks(): Promise<PtydLockSnapshot[]> {
  const entries = await scanPtydLockEntries();
  const live: PtydLockSnapshot[] = [];

  for (const entry of entries) {
    const identified = await identifyPtyd(entry.controlIpcPath);
    if (!identified || identified.protocolVersion !== PTYD_PROTOCOL_VERSION) {
      void removeLockPath(entry.lockPath);
      continue;
    }

    live.push(entry);
  }

  return live.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

async function scanPtydLockEntries(): Promise<PtydLockSnapshot[]> {
  const entries = await readdir(tmpdir(), { withFileTypes: true }).catch(() => []);
  const sessions: PtydLockSnapshot[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith(PTYD_LOCK_PREFIX) || !entry.name.endsWith(PTYD_LOCK_SUFFIX)) continue;

    try {
      const lockPath = join(tmpdir(), entry.name);
      const raw = await readFile(lockPath, "utf8");
      const parsed = JSON.parse(raw) as {
        sessionId?: SessionId;
        controlIpcPath?: string;
        startedAt?: string;
      };
      if (
        typeof parsed.sessionId !== "string" ||
        typeof parsed.controlIpcPath !== "string" ||
        typeof parsed.startedAt !== "string"
      ) {
        continue;
      }

      sessions.push({
        sessionId: parsed.sessionId,
        controlIpcPath: parsed.controlIpcPath,
        startedAt: parsed.startedAt,
        lockPath
      });
    } catch {
      // skip invalid lock
    }
  }

  return sessions;
}

async function identifyPtyd(controlIpcPath: string): Promise<PtydIdentifyResult | null> {
  try {
    return await callJsonRpcIpc<PtydIdentifyResult>(
      {
        ipcPath: controlIpcPath
      },
      "system.identify",
      undefined,
      600
    );
  } catch {
    return null;
  }
}

async function identifyApp(ipcPath: string): Promise<SystemIdentifyResult | null> {
  try {
    return await callJsonRpcIpc<SystemIdentifyResult>(
      {
        ipcPath
      },
      "system.identify",
      undefined,
      1500
    );
  } catch {
    return null;
  }
}

async function removeLockPath(lockPath: string): Promise<void> {
  try {
    await rm(lockPath, { force: true });
  } catch {
    // best effort cleanup
  }
}

function bcmp(left: string, right: string): number {
  return left.localeCompare(right);
}
