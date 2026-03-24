import type { SessionId } from "../shared/ids";
import { startJsonRpcIpcServer } from "../shared/json-rpc-ipc";
import type { SessionRecord } from "../shared/session-record";
import { AppRpcDispatcher, createAppRpcHandlers, type WorkspaceRpcAdapter } from "./app-rpc";
import { SessionFileManager } from "./session-file";

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
  record: SessionRecord;
  stop: () => Promise<void>;
}

export async function startAppRpcServer(options: StartAppRpcServerOptions): Promise<StartedAppRpcServer> {
  const dispatcher = new AppRpcDispatcher(
    createAppRpcHandlers({
      workspace: options.workspace,
      sessionId: options.sessionId,
      pid: options.pid,
      platform: options.platform,
      requestQuit: options.requestQuit
    })
  );

  const server = await startJsonRpcIpcServer({
    ipcPath: options.ipcPath,
    invoke: (method, params) => dispatcher.invoke(method, params)
  });

  const record: SessionRecord = {
    app: "flmux",
    sessionId: options.sessionId,
    workspaceRoot: options.workspaceRoot,
    pid: options.pid ?? process.pid,
    ipcPath: options.ipcPath,
    startedAt: new Date().toISOString()
  };

  const sessionFile = SessionFileManager.fromSessionRecord(record);
  await sessionFile.write(record);

  return {
    ipcPath: options.ipcPath,
    record,
    stop: async () => {
      await server.stop();
      await sessionFile.remove();
    }
  };
}
