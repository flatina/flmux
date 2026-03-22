import type { SessionId } from "../shared/ids";
import type { RpcEndpoint } from "../shared/rpc";
import { type AppRpcClient, createAppRpcClient } from "./app-rpc-client";
import { resolveSession } from "./session-discovery";

export async function resolveAppRpcClient(sessionId?: SessionId | string): Promise<{
  session: Awaited<ReturnType<typeof resolveSession>> | null;
  endpoint: RpcEndpoint;
  client: AppRpcClient;
}> {
  if (!sessionId) {
    const envIpcPath = process.env.FLMUX_APP_IPC?.trim();
    if (envIpcPath) {
      const endpoint: RpcEndpoint = {
        ipcPath: envIpcPath
      };

      return {
        session: null,
        endpoint,
        client: createAppRpcClient(endpoint)
      };
    }
  }

  const session = await resolveSession(sessionId);
  const endpoint: RpcEndpoint = {
    ipcPath: session.ipcPath
  };

  return {
    session,
    endpoint,
    client: createAppRpcClient(endpoint)
  };
}
