import type { SessionId } from "../../shared/ids";
import { getPtydControlIpcPath } from "../../shared/ipc-paths";
import type { AppRpcClient } from "../app-rpc-client";
import { resolveAppRpcClient } from "../context";
import { resolveSession } from "../session-discovery";

export function output(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export async function getClient(sessionId?: string): Promise<AppRpcClient> {
  const { client } = await resolveAppRpcClient(sessionId as SessionId | undefined);
  return client;
}

export async function getPtydEndpoint(sessionId?: string): Promise<{ ipcPath: string }> {
  if (!sessionId) {
    const envSessionId = process.env.FLMUX_SESSION_ID?.trim();
    if (envSessionId) {
      return {
        ipcPath: getPtydControlIpcPath(envSessionId)
      };
    }
  }

  if (sessionId) {
    return {
      ipcPath: getPtydControlIpcPath(sessionId)
    };
  }

  const session = await resolveSession();
  return {
    ipcPath: getPtydControlIpcPath(session.sessionId)
  };
}

export const sessionArg = {
  session: {
    type: "string" as const,
    description: "Target session ID"
  }
};
