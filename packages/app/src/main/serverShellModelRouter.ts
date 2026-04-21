import type { ShellModelAPI, WorkspaceStatusSnapshot } from "@flmux/core/shell";
import type { FlmuxClientRegistry } from "./clientRegistry";
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
  clientRegistry: FlmuxClientRegistry;
}): FlmuxShellModelRouter {
  const authorityViewId = options.authorityViewId ?? 0;

  return {
    registerClient(viewId: number): ClientRegistration {
      // `clientId` is for HTTP/CLI scoping only — the preload-owned desktop
      // renderer routes through `shellModel.path.*` / `flmux.*` and never sends
      // its clientId back. Return only {clientId}: the full registry record
      // carries `bridge`, a Proxy whose get resolves every key to a function;
      // if it crosses the preload wire msgpackr's `value.toJSON` probe
      // succeeds, invokes toJSON as a nested RPC, and the resulting unhandled
      // rejection crashes Bun. Same risk on any other RPC that might be
      // tempted to return a RegisteredFlmuxClient verbatim.
      const { clientId } = options.clientRegistry.registerRenderer(viewId);
      return { clientId };
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
