import { callJsonRpcIpc } from "../shared/json-rpc-ipc";
import type { RpcEndpoint } from "../shared/rpc";

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
