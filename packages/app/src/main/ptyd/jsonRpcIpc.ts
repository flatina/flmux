import { createConnection, createServer } from "node:net";
import { createJsonLineParser, toJsonLine } from "./jsonLines";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: unknown;
}

interface JsonRpcResponse<Result = unknown> {
  jsonrpc: "2.0";
  id: string | null;
  result?: Result;
  error?: {
    code: number;
    message: string;
  };
}

export class JsonRpcMethodError extends Error {
  constructor(
    message: string,
    readonly code: number
  ) {
    super(message);
  }
}

export interface StartedJsonRpcIpcServer {
  ipcPath: string;
  stop(): Promise<void>;
}

export async function startJsonRpcIpcServer(options: {
  ipcPath: string;
  invoke(method: string, params: unknown): Promise<unknown> | unknown;
}): Promise<StartedJsonRpcIpcServer> {
  const server = createServer((socket) => {
    const parser = createJsonLineParser((message) => {
      void handleRequest(socket, message, options.invoke);
    });

    socket.on("data", parser);
    socket.on("error", () => {
      socket.destroy();
    });
  });

  await listenIpc(server, options.ipcPath);

  return {
    ipcPath: options.ipcPath,
    async stop() {
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
  ipcPath: string,
  method: string,
  params: unknown,
  timeoutMs = 5000
): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    const socket = createConnection(ipcPath);
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
        const response = message as JsonRpcResponse<Result>;
        if (response.error) {
          reject(new JsonRpcMethodError(response.error.message, response.error.code));
          return;
        }

        resolve(response.result as Result);
      });
    });

    socket.on("connect", () => {
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method,
        params
      };
      socket.write(toJsonLine(request));
    });

    socket.on("data", parser);
    socket.on("error", (error) => {
      finish(() => reject(error));
    });
    socket.on("close", () => {
      if (!settled) {
        finish(() => reject(new Error(`IPC closed before response: ${method}`)));
      }
    });
  });
}

async function handleRequest(
  socket: ReturnType<typeof createConnection>,
  message: unknown,
  invoke: (method: string, params: unknown) => Promise<unknown> | unknown
) {
  if (!isJsonRpcRequest(message)) {
    socket.end(
      toJsonLine({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid JSON-RPC request" }
      } satisfies JsonRpcResponse)
    );
    return;
  }

  try {
    const result = await invoke(message.method, message.params);
    socket.end(
      toJsonLine({
        jsonrpc: "2.0",
        id: message.id,
        result
      } satisfies JsonRpcResponse)
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
      } satisfies JsonRpcResponse)
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

async function listenIpc(server: ReturnType<typeof createServer>, ipcPath: string) {
  await cleanupIpcListenerPath(ipcPath);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(ipcPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function cleanupIpcListenerPath(ipcPath: string) {
  if (process.platform === "win32") {
    return;
  }

  try {
    await Bun.file(ipcPath).delete();
  } catch {}
}
