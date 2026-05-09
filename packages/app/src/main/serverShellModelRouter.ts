import type { ShellModelAPI, WorkspaceStatusSnapshot } from "@flmux/core/shell";
import type { ClientRegistry } from "./clientRegistry";
import type {
  ClientScopedPathCallInput,
  ClientScopedPathGetInput,
  ClientScopedPathListInput,
  ClientScopedPathSetInput
} from "../shared/rendererBridge";
import type { ClientRegistration, FlmuxClientSummary, FlmuxShellModelRouter } from "./shellModelBridge";

export function createServerShellModelRouter(options: {
  authorityClientId: string;
  authorityViewId?: number;
  shellModel: ShellModelAPI;
  getWorkspace(): Promise<WorkspaceStatusSnapshot>;
  clientRegistry: ClientRegistry;
}): FlmuxShellModelRouter {
  const authorityViewId = options.authorityViewId ?? 0;

  return {
    registerClient(viewId: number, clientId: string): ClientRegistration {
      // The clientId is supplied by the caller — web from `/api/shell/bootstrap`
      // (cookie continuity), desktop pinned to `DESKTOP_CLIENT_ID`. We bind
      // the viewId↔clientId pair (pulling the renderer bridge from
      // `attachRenderer`'s pending queue) and return the same id for echo.
      // The full record carries `bridge`, a Proxy whose get resolves every
      // key to a function; if it crosses the preload wire msgpackr's
      // `value.toJSON` probe succeeds, invokes toJSON as a nested RPC, and
      // the resulting unhandled rejection crashes Bun — return only
      // {clientId} here.
      options.clientRegistry.bindClient(viewId, clientId);
      return { clientId };
    },

    async listClients(): Promise<FlmuxClientSummary[]> {
      return [
        {
          authorityClientId: options.authorityClientId,
          viewId: authorityViewId,
          workspace: await options.getWorkspace()
        }
      ];
    },

    async pathGet(input: ClientScopedPathGetInput) {
      assertAuthorityClientId(input.authorityClientId, options.authorityClientId);
      return await options.shellModel.pathGet(input.path);
    },

    async pathList(input: ClientScopedPathListInput) {
      assertAuthorityClientId(input.authorityClientId, options.authorityClientId);
      return await options.shellModel.pathList(input.path);
    },

    async pathSet(input: ClientScopedPathSetInput) {
      assertAuthorityClientId(input.authorityClientId, options.authorityClientId);
      return await options.shellModel.pathSet(input.path, input.value);
    },

    async pathCall(input: ClientScopedPathCallInput) {
      assertAuthorityClientId(input.authorityClientId, options.authorityClientId);
      return await options.shellModel.pathCall(input.path, input.args);
    }
  };
}

function assertAuthorityClientId(actualClientId: string, authorityClientId: string) {
  if (actualClientId !== authorityClientId) {
    throw new Error(`Unknown flmux client: ${actualClientId}`);
  }
}
