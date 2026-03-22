import { readdir, readFile, rm } from "node:fs/promises";
import type { SessionId } from "../shared/ids";
import { getSessionDir, getSessionRecordPath } from "../shared/paths";
import { isSessionRecord, type SessionRecord } from "../shared/session-record";
import { isRpcEndpointReachable } from "./rpc-client";

export interface DiscoveredSession extends SessionRecord {
  reachable: boolean;
}

async function readSessionRecords(): Promise<SessionRecord[]> {
  try {
    const entries = await readdir(getSessionDir(), { withFileTypes: true });
    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const sessionId = entry.name.replace(/\.json$/u, "");

          try {
            const content = await readFile(getSessionRecordPath(sessionId), "utf8");
            const parsed = JSON.parse(content) as unknown;
            return isSessionRecord(parsed) ? parsed : null;
          } catch {
            return null;
          }
        })
    );

    return sessions
      .filter((session): session is SessionRecord => session !== null)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  } catch {
    return [];
  }
}

async function isSessionReachable(session: SessionRecord): Promise<boolean> {
  return isRpcEndpointReachable({ ipcPath: session.ipcPath });
}

export async function listSessions(): Promise<DiscoveredSession[]> {
  const sessions = await readSessionRecords();

  const discovered = await Promise.all(
    sessions.map(async (session) => ({
      ...session,
      reachable: await isSessionReachable(session)
    }))
  );

  // Auto-remove: unreachable sessions + duplicate IPC paths (keep newest)
  const seen = new Map<string, DiscoveredSession>();
  for (const session of discovered) {
    if (!session.reachable) {
      void removeStaleSessionRecord(session.sessionId);
      continue;
    }

    const existing = seen.get(session.ipcPath);
    if (existing) {
      // Keep the newer one (sessions sorted newest first)
      void removeStaleSessionRecord(session.sessionId);
    } else {
      seen.set(session.ipcPath, session);
    }
  }

  return discovered.filter((s) => seen.get(s.ipcPath)?.sessionId === s.sessionId);
}

export async function resolveSession(sessionId?: SessionId | string): Promise<SessionRecord> {
  const sessions = await listSessions();
  if (sessions.length === 0) {
    throw new Error("No running flmux sessions found.");
  }

  if (sessionId) {
    const session = sessions.find((entry) => entry.sessionId === sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (!session.reachable) {
      throw new Error(`Session is not reachable: ${sessionId}`);
    }

    return session;
  }

  const reachable = sessions.find((entry) => entry.reachable);
  if (!reachable) {
    throw new Error("No reachable flmux sessions found.");
  }

  return reachable;
}

export async function removeStaleSessionRecord(sessionId: SessionId | string): Promise<void> {
  try {
    await rm(getSessionRecordPath(sessionId), { force: true });
  } catch {
    // best effort cleanup
  }
}

export async function cleanupStaleSessions(): Promise<{ removed: string[]; kept: string[] }> {
  const sessions = await readSessionRecords();
  const removed: string[] = [];
  const kept: string[] = [];

  const results = await Promise.all(
    sessions.map(async (session) => ({
      session,
      reachable: await isSessionReachable(session)
    }))
  );

  for (const { session, reachable } of results) {
    if (reachable) {
      kept.push(session.sessionId);
    } else {
      await removeStaleSessionRecord(session.sessionId);
      removed.push(session.sessionId);
    }
  }

  return { removed, kept };
}
