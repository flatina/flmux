import type { WorkspaceStatusSnapshot } from "@flmux/core/shell";
import type {
  ClientScopedPathCallInput,
  ClientScopedPathGetInput,
  ClientScopedPathListInput,
  ClientScopedPathSetInput
} from "../shared/rendererBridge";

export interface FlmuxClientSummary {
  authorityClientId: string;
  viewId: number;
  workspace: WorkspaceStatusSnapshot | null;
}

/** Internal router shape — distinct from the RPC-boundary
 * `ClientRegistrationResult` union (which carries a bind status).
 * The clientId is supplied by the caller (web: from bootstrap; desktop:
 * `DESKTOP_CLIENT_ID`) — the router only confirms it. */
export interface ClientRegistration {
  clientId: string;
}

export interface FlmuxShellModelRouter {
  registerClient(viewId: number, clientId: string): ClientRegistration;
  listClients(): Promise<FlmuxClientSummary[]>;
  pathGet(input: ClientScopedPathGetInput): Promise<unknown>;
  pathList(input: ClientScopedPathListInput): Promise<unknown>;
  pathSet(input: ClientScopedPathSetInput): Promise<unknown>;
  pathCall(input: ClientScopedPathCallInput): Promise<unknown>;
}
