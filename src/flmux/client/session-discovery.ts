import { readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionId } from "../../lib/ids";
import { getAppRpcIpcPath } from "../../lib/ipc/ipc-paths";
import { callJsonRpcIpc } from "../../lib/ipc/json-rpc-ipc";
import { PTYD_PROTOCOL_VERSION, type PtydIdentifyResult } from "../../ptyd/control-plane";
import type { SystemIdentifyResult } from "../rpc/app-rpc";
import { isRpcEndpointReachable } from "./rpc-client";

const PTYD_LOCK_PREFIX = "flmux-ptyd-";
const PTYD_LOCK_SUFFIX = ".lock";

interface PtydLockSnapshot {
  sessionId: SessionId;
  controlIpcPath: string;
  startedAt: string;
  lockPath: string;
}

interface ClassifiedPtydLocks {
  live: PtydLockSnapshot[];
  stale: PtydLockSnapshot[];
}

interface SessionInventory {
  liveLocks: PtydLockSnapshot[];
  sessions: DiscoveredSession[];
}

interface SessionDiscoveryDependencies {
  scanLockEntries: () => Promise<PtydLockSnapshot[]>;
  removeLockPath: (lockPath: string) => Promise<void>;
  identifyPtyd: (controlIpcPath: string) => Promise<PtydIdentifyResult | null>;
  identifyApp: (ipcPath: string) => Promise<SystemIdentifyResult | null>;
  isRpcEndpointReachable: (ipcPath: string) => Promise<boolean>;
  getAppRpcIpcPath: (sessionId: SessionId) => string;
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

export interface SessionDiscoveryApi {
  listSessions(): Promise<DiscoveredSession[]>;
  listRecoverablePtydSessions(): Promise<RecoverablePtydSession[]>;
  resolveSession(sessionId?: SessionId | string): Promise<DiscoveredSession>;
  cleanupStaleSessions(): Promise<{ removed: string[]; kept: string[] }>;
}

const DEFAULT_DEPENDENCIES: SessionDiscoveryDependencies = {
  scanLockEntries: () => scanPtydLockEntries(),
  removeLockPath: (lockPath) => removeLockPath(lockPath),
  identifyPtyd: (controlIpcPath) => identifyPtyd(controlIpcPath),
  identifyApp: (ipcPath) => identifyApp(ipcPath),
  isRpcEndpointReachable: (ipcPath) => isRpcEndpointReachable({ ipcPath }),
  getAppRpcIpcPath: (sessionId) => getAppRpcIpcPath(sessionId)
};

export function createSessionDiscovery(dependencies: Partial<SessionDiscoveryDependencies> = {}): SessionDiscoveryApi {
  const resolvedDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...dependencies
  } satisfies SessionDiscoveryDependencies;

  return {
    async listSessions(): Promise<DiscoveredSession[]> {
      return (await discoverSessionInventory()).sessions;
    },

    async listRecoverablePtydSessions(): Promise<RecoverablePtydSession[]> {
      const inventory = await discoverSessionInventory();
      const liveSessions = new Set(inventory.sessions.map((session) => session.sessionId));

      return inventory.liveLocks
        .filter((lock) => !liveSessions.has(lock.sessionId))
        .map((lock) => ({
          sessionId: lock.sessionId,
          controlIpcPath: lock.controlIpcPath,
          startedAt: lock.startedAt
        }))
        .sort(compareStartedAtDesc);
    },

    async resolveSession(sessionId?: SessionId | string): Promise<DiscoveredSession> {
      const sessions = await this.listSessions();
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
    },

    async cleanupStaleSessions(): Promise<{ removed: string[]; kept: string[] }> {
      const entries = await classifyPtydLockEntries(await resolvedDependencies.scanLockEntries());
      const removed: string[] = [];
      const kept: string[] = [];

      for (const entry of entries.stale) {
        await resolvedDependencies.removeLockPath(entry.lockPath);
        removed.push(entry.sessionId);
      }

      for (const entry of entries.live) {
        kept.push(entry.sessionId);
      }

      return { removed, kept };
    }
  };

  async function listLivePtydLocks(): Promise<PtydLockSnapshot[]> {
    const entries = await classifyPtydLockEntries(await resolvedDependencies.scanLockEntries());
    for (const entry of entries.stale) {
      void resolvedDependencies.removeLockPath(entry.lockPath);
    }
    return entries.live.sort(compareStartedAtDesc);
  }

  async function discoverSessionInventory(): Promise<SessionInventory> {
    const liveLocks = await listLivePtydLocks();
    const sessions = await Promise.all(
      liveLocks.map(async (lock) => {
        const ipcPath = resolvedDependencies.getAppRpcIpcPath(lock.sessionId);
        const reachable = await resolvedDependencies.isRpcEndpointReachable(ipcPath);
        if (!reachable) {
          return null;
        }

        const identify = await resolvedDependencies.identifyApp(ipcPath);
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

    return {
      liveLocks,
      sessions: sessions.filter((session): session is DiscoveredSession => session !== null).sort(compareStartedAtDesc)
    };
  }

  async function classifyPtydLockEntries(entries: PtydLockSnapshot[]): Promise<ClassifiedPtydLocks> {
    const classified: ClassifiedPtydLocks = {
      live: [],
      stale: []
    };

    for (const entry of entries) {
      const identified = await resolvedDependencies.identifyPtyd(entry.controlIpcPath);
      if (!identified || identified.protocolVersion !== PTYD_PROTOCOL_VERSION) {
        classified.stale.push(entry);
        continue;
      }

      classified.live.push(entry);
    }

    return classified;
  }
}

const defaultSessionDiscovery = createSessionDiscovery();

export async function listSessions(): Promise<DiscoveredSession[]> {
  return defaultSessionDiscovery.listSessions();
}

export async function listRecoverablePtydSessions(): Promise<RecoverablePtydSession[]> {
  return defaultSessionDiscovery.listRecoverablePtydSessions();
}

export async function resolveSession(sessionId?: SessionId | string): Promise<DiscoveredSession> {
  return defaultSessionDiscovery.resolveSession(sessionId);
}

export async function cleanupStaleSessions(): Promise<{ removed: string[]; kept: string[] }> {
  return defaultSessionDiscovery.cleanupStaleSessions();
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

function compareStartedAtDesc(left: { startedAt: string }, right: { startedAt: string }): number {
  return right.startedAt.localeCompare(left.startedAt);
}
