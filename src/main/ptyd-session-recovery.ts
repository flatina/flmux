import type { SessionId } from "../shared/ids";
import { listRecoverablePtydSessions, listSessions } from "../cli/session-discovery";

export async function resolveStartupSessionId(): Promise<SessionId | null> {
  const explicit = getExplicitSessionIdArg();
  if (explicit) {
    return explicit;
  }

  const orphans = await listRecoverablePtydSessions();
  if (orphans.length !== 1) {
    return null;
  }

  const liveSessions = await listSessions();
  if (liveSessions.length > 0) {
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
