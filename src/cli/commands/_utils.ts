import type { SessionId } from "../../shared/ids";
import { getPtydControlIpcPath } from "../../shared/ipc-paths";
import type { AppRpcClient } from "../app-rpc-client";
import { resolveAppRpcClient } from "../context";

export function output(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export async function getClient(sessionId?: string): Promise<AppRpcClient> {
  const { client } = await resolveAppRpcClient(sessionId as SessionId | undefined);
  return client;
}

export function getPtydEndpoint(): { ipcPath: string } {
  return {
    ipcPath: getPtydControlIpcPath(process.env.FLMUX_ROOT ?? process.cwd())
  };
}

export const sessionArg = {
  session: {
    type: "string" as const,
    description: "Target session ID"
  }
};
