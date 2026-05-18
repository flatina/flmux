import type { CapDef, ClientOf, ImplOf } from "bunite-core/rpc";
import type { ShellClient } from "./shell";
import type { ExtensionPaneSpec } from "./pane";

export interface ExtensionServerInitContext {
  dataDir: string;
}

/** Per-session context. Identity lives in closure (sessionId/userId free
 *  variables inside the impl), never on the wire. `serve` registers a cap
 *  on the connection scoped to this session; `bootstrap` reaches the same
 *  connection's renderer-served caps (lazy — renderer's `onLoad` registers
 *  after server's `onSession`); `onDispose` runs on conn close. */
export interface ExtensionServerSessionContext {
  dataDir: string;
  sessionId: string;
  userId: string;
  shell: ShellClient;
  serve<C extends CapDef<any, any>>(cap: C, impl: ImplOf<C>): void;
  bootstrap<C extends CapDef<any, any>>(cap: C): Promise<ClientOf<C>>;
  onDispose(fn: () => void): void;
}

export interface ExtensionServerPaneContext {
  dataDir: string;
  shell: ShellClient;
}

export interface ExtensionServerPaneInstance {
  dispose?(): void;
}

export interface ExtensionServerDefinition {
  panes?: ExtensionPaneSpec[];
  onInit?(ctx: ExtensionServerInitContext): void | Promise<void>;
  onSession?(ctx: ExtensionServerSessionContext): void | Promise<void>;
  onPaneConnected?(
    paneId: string,
    sessionId: string,
    ctx: ExtensionServerPaneContext
  ): ExtensionServerPaneInstance | void | Promise<ExtensionServerPaneInstance | void>;
}

export function defineExtensionServer<T extends ExtensionServerDefinition>(definition: T): T {
  return definition;
}
