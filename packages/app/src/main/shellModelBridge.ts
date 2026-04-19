import type { WorkspaceStatusSnapshot } from "@flmux/core/shell";
import type {
  ClientScopedPathCallInput,
  ClientScopedPathGetInput,
  ClientScopedPathListInput,
  ClientScopedPathSetInput
} from "../shared/rendererBridge";

export interface FlmuxClientSummary {
  clientId: string;
  viewId: number;
  workspace: WorkspaceStatusSnapshot | null;
}

/** Internal router shape — distinct from the RPC-boundary
 * `ClientRegistrationResult` union (which carries an attachment-binding
 * status). The router only mints the clientId; the RPC handler composes
 * the full response. */
export interface ClientRegistration {
  clientId: string;
}

export interface FlmuxShellModelRouter {
  registerClient(viewId: number): ClientRegistration;
  listClients(): Promise<FlmuxClientSummary[]>;
  pathGet(input: ClientScopedPathGetInput): Promise<unknown>;
  pathList(input: ClientScopedPathListInput): Promise<unknown>;
  pathSet(input: ClientScopedPathSetInput): Promise<unknown>;
  pathCall(input: ClientScopedPathCallInput): Promise<unknown>;
}
