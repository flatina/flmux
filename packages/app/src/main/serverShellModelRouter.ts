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
      // clientId is caller-supplied — web from `/api/shell/bootstrap` (cookie
      // continuity), desktop pinned to `DESKTOP_CLIENT_ID`. This router only
      // owns the clientId↔viewId binding; `bindClientTransport` (main.ts)
      // wires the connection / extension serves.
      options.clientRegistry.attachLive(clientId, viewId);
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
