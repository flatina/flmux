export interface JsonRpcRequest<Params = unknown> {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: Params;
}

export interface JsonRpcSuccessResponse<Result> {
  jsonrpc: "2.0";
  id: string;
  result: Result;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse<Result> = JsonRpcSuccessResponse<Result> | JsonRpcErrorResponse;

let nextJsonRpcRequestId = 0;

export function createJsonRpcRequest<Params>(method: string, params: Params): JsonRpcRequest<Params> {
  nextJsonRpcRequestId += 1;

  return {
    jsonrpc: "2.0",
    id: `rpc.${nextJsonRpcRequestId}`,
    method,
    params
  };
}

export function getJsonRpcResult<Result>(response: JsonRpcResponse<Result>): Result {
  if ("error" in response) {
    throw new Error(response.error.message);
  }

  return response.result;
}
