import { describe, expect, test } from "bun:test";
import type { SessionId } from "../../lib/ids";
import { PTYD_PROTOCOL_VERSION, type PtydIdentifyResult } from "../../ptyd/control-plane";
import type { SystemIdentifyResult } from "../rpc/app-rpc";
import { createSessionDiscovery } from "./session-discovery";

type FakeLockEntry = {
  sessionId: SessionId;
  controlIpcPath: string;
  startedAt: string;
  lockPath: string;
};

describe("session-discovery", () => {
  test("lists recoverable sessions without rescanning inventory", async () => {
    const scanCalls: string[] = [];
    const removedLockPaths: string[] = [];
    const identifyPtydCalls: string[] = [];
    const reachableCalls: string[] = [];
    const identifyAppCalls: string[] = [];

    const staleLock = makeLock("stale", "2026-03-28T10:00:00.000Z");
    const recoverableLock = makeLock("recoverable", "2026-03-28T12:00:00.000Z");
    const runningLock = makeLock("running", "2026-03-28T11:00:00.000Z");

    const sessionDiscovery = createSessionDiscovery({
      async scanLockEntries() {
        scanCalls.push("scan");
        return [staleLock, recoverableLock, runningLock];
      },
      async removeLockPath(lockPath) {
        removedLockPaths.push(lockPath);
      },
      async identifyPtyd(controlIpcPath) {
        identifyPtydCalls.push(controlIpcPath);
        if (controlIpcPath === staleLock.controlIpcPath) {
          return null;
        }
        return makePtydIdentify(controlIpcPath);
      },
      async isRpcEndpointReachable(ipcPath) {
        reachableCalls.push(ipcPath);
        return ipcPath === `app:${runningLock.sessionId}`;
      },
      async identifyApp(ipcPath) {
        identifyAppCalls.push(ipcPath);
        if (ipcPath !== `app:${runningLock.sessionId}`) {
          return null;
        }
        return makeSystemIdentify(runningLock.sessionId, "C:/project/running");
      },
      getAppRpcIpcPath(sessionId) {
        return `app:${sessionId}`;
      }
    });

    const recoverable = await sessionDiscovery.listRecoverablePtydSessions();

    expect(recoverable).toEqual([
      {
        sessionId: recoverableLock.sessionId,
        controlIpcPath: recoverableLock.controlIpcPath,
        startedAt: recoverableLock.startedAt
      }
    ]);
    expect(scanCalls).toEqual(["scan"]);
    expect(identifyPtydCalls).toEqual([
      staleLock.controlIpcPath,
      recoverableLock.controlIpcPath,
      runningLock.controlIpcPath
    ]);
    expect(reachableCalls).toEqual([`app:${recoverableLock.sessionId}`, `app:${runningLock.sessionId}`]);
    expect(identifyAppCalls).toEqual([`app:${runningLock.sessionId}`]);
    expect(removedLockPaths).toEqual([staleLock.lockPath]);
  });

  test("cleanupStaleSessions removes only stale locks and keeps live ones", async () => {
    const removedLockPaths: string[] = [];
    const staleLock = makeLock("stale", "2026-03-28T10:00:00.000Z");
    const liveLock = makeLock("live", "2026-03-28T11:00:00.000Z");

    const sessionDiscovery = createSessionDiscovery({
      async scanLockEntries() {
        return [staleLock, liveLock];
      },
      async removeLockPath(lockPath) {
        removedLockPaths.push(lockPath);
      },
      async identifyPtyd(controlIpcPath) {
        return controlIpcPath === liveLock.controlIpcPath ? makePtydIdentify(controlIpcPath) : null;
      },
      async identifyApp() {
        return null;
      },
      async isRpcEndpointReachable() {
        return false;
      },
      getAppRpcIpcPath(sessionId) {
        return `app:${sessionId}`;
      }
    });

    const result = await sessionDiscovery.cleanupStaleSessions();

    expect(result).toEqual({
      removed: [staleLock.sessionId],
      kept: [liveLock.sessionId]
    });
    expect(removedLockPaths).toEqual([staleLock.lockPath]);
  });
});

function makeLock(name: string, startedAt: string): FakeLockEntry {
  return {
    sessionId: `${name}-session` as SessionId,
    controlIpcPath: `control:${name}`,
    startedAt,
    lockPath: `lock:${name}`
  };
}

function makePtydIdentify(controlIpcPath: string): PtydIdentifyResult {
  return {
    app: "flmux-ptyd",
    daemonId: `daemon:${controlIpcPath}` as PtydIdentifyResult["daemonId"],
    sessionId: controlIpcPath.replace("control:", "").concat("-session") as SessionId,
    pid: 100,
    controlIpcPath,
    eventsIpcPath: controlIpcPath.replace("control:", "events:"),
    startedAt: "2026-03-28T00:00:00.000Z",
    protocolVersion: PTYD_PROTOCOL_VERSION
  };
}

function makeSystemIdentify(sessionId: SessionId, workspaceRoot: string): SystemIdentifyResult {
  return {
    app: "flmux",
    sessionId,
    workspaceRoot,
    pid: 200,
    platform: "win32",
    activePaneId: null,
    paneCount: 1
  };
}
