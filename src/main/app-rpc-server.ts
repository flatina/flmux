import type { SessionId } from "../shared/ids";
import { startJsonRpcIpcServer } from "../shared/json-rpc-ipc";
import type { RendererWorkspaceBridge } from "./renderer-workspace-bridge";
import { AppRpcDispatcher, createAppRpcHandlers } from "./app-rpc";

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
  const dispatcher = new AppRpcDispatcher(
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
    stop: async () => {
      await server.stop();
    }
  };
}
