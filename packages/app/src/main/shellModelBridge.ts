import type { FlmuxClientRegistry } from "./clientRegistry";
import type {
  ClientRegistrationResult,
  ClientScopedPathCallInput,
  ClientScopedPathGetInput,
  ClientScopedPathListInput,
  ClientScopedPathSetInput
} from "../shared/rendererBridge";

export interface FlmuxClientSummary {
  clientId: string;
  viewId: number;
  workspace: unknown | null;
}

export interface FlmuxShellModelRouter {
  registerClient(viewId: number): ClientRegistrationResult;
  listClients(): Promise<FlmuxClientSummary[]>;
  pathGet(input: ClientScopedPathGetInput): Promise<unknown>;
  pathList(input: ClientScopedPathListInput): Promise<unknown>;
  pathSet(input: ClientScopedPathSetInput): Promise<unknown>;
  pathCall(input: ClientScopedPathCallInput): Promise<unknown>;
}

export function createShellModelRouter(registry: FlmuxClientRegistry): FlmuxShellModelRouter {
  return {
    registerClient(viewId) {
      return { clientId: registry.registerRenderer(viewId).clientId };
    },

    async listClients() {
      return Promise.all(
        registry.list().map(async (client) => {
          try {
            const workspace = await client.bridge.requestProxy["shellModel.path.get"]({
              path: "/status/workspace"
            });

            return {
              clientId: client.clientId,
              viewId: client.viewId,
              workspace: workspace.ok && workspace.found ? workspace.value : null
            };
          } catch {
            return {
              clientId: client.clientId,
              viewId: client.viewId,
              workspace: null
            };
          }
        })
      );
    },

    pathGet(input) {
      return registry.resolve(input.clientId).bridge.requestProxy["shellModel.path.get"]({
        path: input.path
      });
    },

    pathList(input) {
      return registry.resolve(input.clientId).bridge.requestProxy["shellModel.path.list"]({
        path: input.path
      });
    },

    pathSet(input) {
      return registry.resolve(input.clientId).bridge.requestProxy["shellModel.path.set"]({
        path: input.path,
        value: input.value
      });
    },

    pathCall(input) {
      return registry.resolve(input.clientId).bridge.requestProxy["shellModel.path.call"]({
        path: input.path,
        args: input.args
      });
    }
  };
}

