import { createConnection, createServer } from "node:net";
import { cleanupIpcListenerPath, prepareIpcListenerPath } from "./ipc-socket";
import { createJsonLineParser, toJsonLine } from "./json-lines";
import type { JsonRpcErrorResponse, JsonRpcRequest, JsonRpcResponse } from "./json-rpc";
import { createJsonRpcRequest, getJsonRpcResult } from "./json-rpc";
import type { RpcEndpoint } from "../rpc";

export interface StartJsonRpcIpcServerOptions {
  ipcPath: string;
  invoke: (method: string, params: unknown) => Promise<unknown> | unknown;
}

export interface StartedJsonRpcIpcServer {
  ipcPath: string;
  stop: () => Promise<void>;
}

export async function startJsonRpcIpcServer(options: StartJsonRpcIpcServerOptions): Promise<StartedJsonRpcIpcServer> {
  await prepareIpcListenerPath(options.ipcPath);

  const server = createServer((socket) => {
    const parser = createJsonLineParser((message) => {
      void handleRequest(socket, message, options.invoke);
    });

    socket.on("data", parser);
    socket.on("error", () => {
      socket.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.ipcPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    ipcPath: options.ipcPath,
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
      await cleanupIpcListenerPath(options.ipcPath);
    }
  };
}

export async function callJsonRpcIpc<Result>(
  endpoint: RpcEndpoint,
  method: string,
  params: unknown,
  timeoutMs = 1_500
): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    const socket = createConnection(endpoint.ipcPath);
    const timeout = setTimeout(() => {
      socket.destroy(new Error(`IPC request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      callback();
    };

    const parser = createJsonLineParser((message) => {
      finish(() => {
        socket.end();
        try {
          resolve(getJsonRpcResult(message as JsonRpcResponse<Result>));
        } catch (error) {
          reject(error);
        }
      });
    });

    socket.on("connect", () => {
      socket.write(toJsonLine(createJsonRpcRequest(method, params)));
    });

    socket.on("data", parser);

    socket.on("error", (error) => {
      finish(() => reject(error));
    });

    socket.on("close", () => {
      if (!settled) {
        finish(() => reject(new Error(`IPC request closed before response: ${method}`)));
      }
    });
  });
}

async function handleRequest(
  socket: ReturnType<typeof createConnection>,
  message: unknown,
  invoke: (method: string, params: unknown) => Promise<unknown> | unknown
): Promise<void> {
  if (!isJsonRpcRequest(message)) {
    const response: JsonRpcErrorResponse = {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: "Invalid JSON-RPC request"
      }
    };
    socket.end(toJsonLine(response));
    return;
  }

  try {
    const result = await invoke(message.method, message.params);
    socket.end(
      toJsonLine({
        jsonrpc: "2.0",
        id: message.id,
        result
      })
    );
  } catch (error) {
    socket.end(
      toJsonLine({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error)
        }
      } satisfies JsonRpcErrorResponse)
    );
  }
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object") {
    return false;
  }

  const request = value as Partial<JsonRpcRequest>;
  return request.jsonrpc === "2.0" && typeof request.id === "string" && typeof request.method === "string";
}
