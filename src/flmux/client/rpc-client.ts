import { createConnection } from "node:net";
import { callJsonRpcIpc } from "../../lib/ipc/json-rpc-ipc";
import { createJsonLineParser } from "../../lib/ipc/json-lines";
import { getPropertyEventsIpcPath } from "../../lib/ipc/ipc-paths";
import type { SessionId } from "../../lib/ids";
import type { RpcEndpoint } from "../../lib/rpc";
import type { AppRpcMethod, AppRpcParams, AppRpcResult } from "../rpc/app-rpc";
import type { PropertyChangeEvent } from "../../types/property";
import { resolveSession } from "./session-discovery";

export async function callJsonRpc<Result>(
  endpoint: RpcEndpoint,
  method: string,
  params: unknown,
  timeoutMs = 1_500
): Promise<Result> {
  return callJsonRpcIpc<Result>(endpoint, method, params, timeoutMs);
}

export async function isRpcEndpointReachable(endpoint: RpcEndpoint, timeoutMs = 600): Promise<boolean> {
  try {
    await callJsonRpc(endpoint, "system.ping", undefined, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

export interface AppRpcClient {
  call<Method extends AppRpcMethod>(
    method: Method,
    params: AppRpcParams<Method>,
    timeoutMs?: number
  ): Promise<AppRpcResult<Method>>;
}

export function createAppRpcClient(endpoint: RpcEndpoint): AppRpcClient {
  return {
    call<Method extends AppRpcMethod>(
      method: Method,
      params: AppRpcParams<Method>,
      timeoutMs?: number
    ): Promise<AppRpcResult<Method>> {
      return callJsonRpc<AppRpcResult<Method>>(endpoint, method, params, timeoutMs);
    }
  };
}

export interface PropertyChangeStream {
  close: () => void;
  closed: Promise<void>;
}

export function subscribePropertyChanges(
  sessionId: SessionId | string,
  handler: (event: PropertyChangeEvent) => void
): PropertyChangeStream {
  const socket = createConnection(getPropertyEventsIpcPath(sessionId));
  const parser = createJsonLineParser((message) => {
    handler(message as PropertyChangeEvent);
  });
  const closed = new Promise<void>((resolve) => {
    socket.on("close", () => resolve());
  });

  socket.on("data", parser);
  socket.on("error", () => {
    socket.destroy();
  });

  return {
    close: () => {
      socket.end();
      socket.destroy();
    },
    closed
  };
}

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
