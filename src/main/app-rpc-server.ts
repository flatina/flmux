import type { SessionId } from "../shared/ids";
import { startJsonRpcIpcServer } from "../shared/json-rpc-ipc";
import { AppRpcDispatcher, createAppRpcHandlers, type WorkspaceRpcAdapter } from "./app-rpc";

export interface StartAppRpcServerOptions {
  workspace: WorkspaceRpcAdapter;
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
      workspace: options.workspace,
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
