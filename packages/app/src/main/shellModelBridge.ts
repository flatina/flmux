import { app } from "bunite-core";
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

export function installShellModelBridge(router: FlmuxShellModelRouter) {
  app.handle("flmux.client.register", (_params, ctx) => {
    return router.registerClient(ctx.viewId);
  });

  app.handle("flmux.model.path.get", async (params) => {
    return router.pathGet(params as ClientScopedPathGetInput);
  });

  app.handle("flmux.model.path.list", async (params) => {
    return router.pathList(params as ClientScopedPathListInput);
  });

  app.handle("flmux.model.path.set", async (params) => {
    return router.pathSet(params as ClientScopedPathSetInput);
  });

  app.handle("flmux.model.path.call", async (params) => {
    return router.pathCall(params as ClientScopedPathCallInput);
  });
}
