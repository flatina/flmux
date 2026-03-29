import type { Brand, SessionId, TerminalRuntimeId, PtyDaemonId, PaneId, TabId } from "../types/ids";
export type { Brand, SessionId, TerminalRuntimeId, PtyDaemonId, PaneId, TabId };

export function asSessionId(value: string): SessionId { return value as SessionId; }
export function asTerminalRuntimeId(value: string): TerminalRuntimeId { return value as TerminalRuntimeId; }
export function asPtyDaemonId(value: string): PtyDaemonId { return value as PtyDaemonId; }
export function asPaneId(value: string): PaneId { return value as PaneId; }
export function asTabId(value: string): TabId { return value as TabId; }
