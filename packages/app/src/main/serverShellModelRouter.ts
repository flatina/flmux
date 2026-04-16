import type { ShellModelAPI, WorkspaceStatusSnapshot } from "@flmux/core/shell";
import type { FlmuxClientRegistry } from "./clientRegistry";
import type {
  ClientRegistrationResult,
  ClientScopedPathCallInput,
  ClientScopedPathGetInput,
  ClientScopedPathListInput,
  ClientScopedPathSetInput
} from "../shared/rendererBridge";
import type { FlmuxClientSummary, FlmuxShellModelRouter } from "./shellModelBridge";

export function createServerShellModelRouter(options: {
  authorityClientId: string;
  authorityViewId?: number;
  shellModel: ShellModelAPI;
  getWorkspace(): Promise<WorkspaceStatusSnapshot>;
  clientRegistry: FlmuxClientRegistry;
}): FlmuxShellModelRouter {
  const authorityViewId = options.authorityViewId ?? 0;

  return {
    registerClient(viewId: number): ClientRegistrationResult {
      return options.clientRegistry.registerRenderer(viewId);
    },

    async listClients(): Promise<FlmuxClientSummary[]> {
      return [
        {
          clientId: options.authorityClientId,
          viewId: authorityViewId,
          workspace: await options.getWorkspace()
        }
      ];
    },

    async pathGet(input: ClientScopedPathGetInput) {
      assertAuthorityClientId(input.clientId, options.authorityClientId);
      return await options.shellModel.pathGet(input.path);
    },

    async pathList(input: ClientScopedPathListInput) {
      assertAuthorityClientId(input.clientId, options.authorityClientId);
      return await options.shellModel.pathList(input.path);
    },

    async pathSet(input: ClientScopedPathSetInput) {
      assertAuthorityClientId(input.clientId, options.authorityClientId);
      return await options.shellModel.pathSet(input.path, input.value);
    },

    async pathCall(input: ClientScopedPathCallInput) {
      assertAuthorityClientId(input.clientId, options.authorityClientId);
      return await options.shellModel.pathCall(input.path, input.args);
    }
  };
}

function assertAuthorityClientId(actualClientId: string, authorityClientId: string) {
  if (actualClientId !== authorityClientId) {
    throw new Error(`Unknown flmux client: ${actualClientId}`);
  }
}
