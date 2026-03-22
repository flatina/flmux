export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type PaneId = Brand<string, "PaneId">;
export type SessionId = Brand<string, "SessionId">;
export type TerminalRuntimeId = Brand<string, "TerminalRuntimeId">;
export type TabId = Brand<string, "TabId">;
export type PtyDaemonId = Brand<string, "PtyDaemonId">;

export function asPaneId(value: string): PaneId {
  return value as PaneId;
}

export function asSessionId(value: string): SessionId {
  return value as SessionId;
}

export function asTerminalRuntimeId(value: string): TerminalRuntimeId {
  return value as TerminalRuntimeId;
}

export function asPtyDaemonId(value: string): PtyDaemonId {
  return value as PtyDaemonId;
}

export function asTabId(value: string): TabId {
  return value as TabId;
}

export function createTabId(prefix = "tab"): TabId {
  return asTabId(`${prefix}.${crypto.randomUUID().slice(0, 8)}`);
}

export function createPaneId(prefix = "pane"): PaneId {
  return asPaneId(`${prefix}.${crypto.randomUUID().slice(0, 8)}`);
}

export function createSessionId(): SessionId {
  return asSessionId(crypto.randomUUID());
}

export function createTerminalRuntimeId(): TerminalRuntimeId {
  return asTerminalRuntimeId(`rt.${crypto.randomUUID().slice(0, 12)}`);
}
