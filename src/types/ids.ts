export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type SessionId = Brand<string, "SessionId">;
export type TerminalRuntimeId = Brand<string, "TerminalRuntimeId">;
export type PtyDaemonId = Brand<string, "PtyDaemonId">;
export type PaneId = Brand<string, "PaneId">;
export type TabId = Brand<string, "TabId">;

export function asSessionId(value: string): SessionId { return value as SessionId; }
export function asTerminalRuntimeId(value: string): TerminalRuntimeId { return value as TerminalRuntimeId; }
export function asPtyDaemonId(value: string): PtyDaemonId { return value as PtyDaemonId; }
export function asPaneId(value: string): PaneId { return value as PaneId; }
export function asTabId(value: string): TabId { return value as TabId; }
