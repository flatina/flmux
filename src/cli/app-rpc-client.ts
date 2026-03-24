import type { AppRpcMethod, AppRpcParams, AppRpcResult } from "../shared/app-rpc";
import type { RpcEndpoint } from "../shared/rpc";
import { callJsonRpc } from "./rpc-client";

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
