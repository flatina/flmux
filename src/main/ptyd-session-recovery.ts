import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionId } from "../shared/ids";
import { getSessionDir, getSessionRecordPath } from "../shared/paths";
import { callJsonRpcIpc } from "../shared/json-rpc-ipc";
import { isSessionRecord } from "../shared/session-record";
import type { PtydIdentifyResult } from "../shared/ptyd-control-plane";
import { PTYD_PROTOCOL_VERSION } from "../shared/ptyd-control-plane";
import { isRpcEndpointReachable } from "../cli/rpc-client";

const PTYD_LOCK_PREFIX = "flmux-ptyd-";
const PTYD_LOCK_SUFFIX = ".lock";

export interface RecoverablePtyd {
  sessionId: SessionId;
  startedAt: string;
  controlIpcPath: string;
}

export async function resolveStartupSessionId(): Promise<SessionId | null> {
  const explicit = getExplicitSessionIdArg();
  if (explicit) {
    return explicit;
  }

  const orphans = await listRecoverablePtydSessions();
  if (orphans.length !== 1) {
    return null;
  }

  const liveAppSessions = await countReachableAppSessions();
  if (liveAppSessions > 0) {
    return null;
  }

  return orphans[0]!.sessionId;
}

function getExplicitSessionIdArg(): SessionId | null {
  const index = process.argv.findIndex((value) => value === "--session");
  if (index < 0) {
    return null;
  }

  const value = process.argv[index + 1]?.trim();
  return value ? (value as SessionId) : null;
}

export async function listRecoverablePtydSessions(): Promise<RecoverablePtyd[]> {
  const entries = await readdir(tmpdir(), { withFileTypes: true }).catch(() => []);
  const sessions: RecoverablePtyd[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith(PTYD_LOCK_PREFIX) || !entry.name.endsWith(PTYD_LOCK_SUFFIX)) continue;

    try {
      const raw = await readFile(join(tmpdir(), entry.name), "utf8");
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

      const identified = await identifyPtyd(parsed.controlIpcPath);
      if (!identified || identified.protocolVersion !== PTYD_PROTOCOL_VERSION) {
        continue;
      }

      const appReachable = await isSessionAppReachable(parsed.sessionId);
      if (appReachable) {
        continue;
      }

      sessions.push({
        sessionId: parsed.sessionId,
        startedAt: parsed.startedAt,
        controlIpcPath: parsed.controlIpcPath
      });
    } catch {
      // skip invalid lock
    }
  }

  sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
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

async function countReachableAppSessions(): Promise<number> {
  const recordsDirEntries = await readdir(getSessionDir(), { withFileTypes: true }).catch(() => []);

  let count = 0;
  for (const entry of recordsDirEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const sessionId = entry.name.replace(/\.json$/u, "");
    if (await isSessionAppReachable(sessionId as SessionId)) {
      count += 1;
    }
  }

  return count;
}

async function isSessionAppReachable(sessionId: SessionId): Promise<boolean> {
  try {
    const raw = await readFile(getSessionRecordPath(sessionId), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isSessionRecord(parsed)) {
      return false;
    }

    return await isRpcEndpointReachable({ ipcPath: parsed.ipcPath });
  } catch {
    return false;
  }
}
