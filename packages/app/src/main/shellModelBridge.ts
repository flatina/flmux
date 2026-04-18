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
