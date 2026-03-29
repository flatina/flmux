import type { SessionId } from "../../lib/ids";
import { callJsonRpcIpc } from "../../lib/ipc/json-rpc-ipc";
import { listRecoverablePtydSessions } from "../client/session-discovery";
import type { RecoverablePtydSession } from "../client/session-discovery";

export type StartupOrphanPtydPolicy = "ask" | "recover" | "reset" | "exit";

export type StartupSessionResolution =
  | {
      kind: "recover";
      sessionId: SessionId;
      orphanCount: number;
    }
  | {
      kind: "fresh";
      orphanCount: number;
      stoppedSessionIds: SessionId[];
    }
  | {
      kind: "exit";
      orphanCount: number;
      reason: string;
    };

export async function resolveStartupSession(
  selectPolicy: (orphans: RecoverablePtydSession[]) => Promise<StartupOrphanPtydPolicy> = async () =>
    resolveStartupOrphanPtydPolicy()
): Promise<StartupSessionResolution> {
  const explicit = getExplicitSessionIdArg();
  if (explicit) {
    return {
      kind: "recover",
      sessionId: explicit,
      orphanCount: 0
    };
  }

  const orphans = await listRecoverablePtydSessions();
  if (orphans.length === 0) {
    return {
      kind: "fresh",
      orphanCount: 0,
      stoppedSessionIds: []
    };
  }

  const policy = await selectPolicy(orphans);
  switch (policy) {
    case "recover": {
      const [selected, ...rest] = orphans;
      if (rest.length > 0) {
        await stopRecoverablePtydSessions(rest);
      }
      return {
        kind: "recover",
        sessionId: selected!.sessionId,
        orphanCount: orphans.length
      };
    }
    case "reset": {
      const stoppedSessionIds = await stopRecoverablePtydSessions(orphans);
      return {
        kind: "fresh",
        orphanCount: orphans.length,
        stoppedSessionIds
      };
    }
    case "exit":
      return {
        kind: "exit",
        orphanCount: orphans.length,
        reason:
          orphans.length === 1
            ? `Found orphan ptyd session ${orphans[0]!.sessionId}.`
            : `Found ${orphans.length} orphan ptyd sessions.`
      };
    case "ask":
      throw new Error("Unexpected unresolved orphan ptyd policy");
  }
}

function getExplicitSessionIdArg(): SessionId | null {
  const index = process.argv.findIndex((value) => value === "--session");
  if (index < 0) {
    return null;
  }

  const value = process.argv[index + 1]?.trim();
  return value ? (value as SessionId) : null;
}

export function resolveStartupOrphanPtydPolicy(
  argv = process.argv,
  env: Record<string, string | undefined> = process.env
): StartupOrphanPtydPolicy {
  const explicit = readStartupOrphanPtydPolicyArg(argv);
  if (explicit) {
    return explicit;
  }

  const envValue = parseStartupOrphanPtydPolicy(env.FLMUX_ORPHAN_PTYD);
  return envValue ?? "ask";
}

export function parseStartupOrphanPtydPolicy(value: string | undefined): StartupOrphanPtydPolicy | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "ask" || normalized === "recover" || normalized === "reset" || normalized === "exit") {
    return normalized;
  }

  return null;
}

function readStartupOrphanPtydPolicyArg(argv: string[]): StartupOrphanPtydPolicy | null {
  const inline = argv.find((value) => value.startsWith("--orphan-ptyd="));
  if (inline) {
    return parseStartupOrphanPtydPolicy(inline.slice("--orphan-ptyd=".length));
  }

  const index = argv.findIndex((value) => value === "--orphan-ptyd");
  if (index >= 0) {
    return parseStartupOrphanPtydPolicy(argv[index + 1]);
  }

  return null;
}

async function stopRecoverablePtydSessions(sessions: RecoverablePtydSession[]): Promise<SessionId[]> {
  const stopped: SessionId[] = [];

  for (const session of sessions) {
    try {
      await callJsonRpcIpc(
        {
          ipcPath: session.controlIpcPath
        },
        "daemon.stop",
        undefined,
        1000
      );
      stopped.push(session.sessionId);
    } catch {
      // best effort
    }
  }

  return stopped;
}
