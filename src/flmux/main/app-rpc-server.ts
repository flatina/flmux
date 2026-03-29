import type { SessionId } from "../../lib/ids";
import { startJsonRpcIpcServer } from "../../lib/ipc/json-rpc-ipc";
import { RpcDispatcher } from "../../lib/rpc";
import type { RendererWorkspaceBridge } from "./renderer-workspace-bridge";
import { type AppRpcHandlers, createAppRpcHandlers } from "./app-rpc";

export interface StartAppRpcServerOptions {
  bridge: RendererWorkspaceBridge;
  sessionId: SessionId;
  workspaceRoot: string;
  ipcPath: string;
  pid?: number;
  platform?: string;
  requestQuit?: () => void;
}

export interface StartedAppRpcServer {
  ipcPath: string;
  stop: () => Promise<void>;
}

export async function startAppRpcServer(options: StartAppRpcServerOptions): Promise<StartedAppRpcServer> {
  const dispatcher = new RpcDispatcher<AppRpcHandlers>(
    createAppRpcHandlers({
      bridge: options.bridge,
      sessionId: options.sessionId,
      workspaceRoot: options.workspaceRoot,
      pid: options.pid,
      platform: options.platform,
      requestQuit: options.requestQuit
    })
  );

  const server = await startJsonRpcIpcServer({
    ipcPath: options.ipcPath,
    invoke: (method, params) => dispatcher.invoke(method, params)
  });

  return {
    ipcPath: options.ipcPath,
    stop: () => server.stop()
  };
}
