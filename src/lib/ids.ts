export type { Brand, SessionId, TerminalRuntimeId, PtyDaemonId, PaneId, TabId } from "../types/ids";
export { asSessionId, asTerminalRuntimeId, asPtyDaemonId, asPaneId, asTabId } from "../types/ids";
import type { SessionId, TerminalRuntimeId, PaneId, TabId } from "../types/ids";

export function createSessionId(): SessionId {
  return crypto.randomUUID() as SessionId;
}

export function createTerminalRuntimeId(): TerminalRuntimeId {
  return `rt.${crypto.randomUUID().slice(0, 12)}` as TerminalRuntimeId;
}

export function createPaneId(prefix = "pane"): PaneId {
  return `${prefix}.${crypto.randomUUID().slice(0, 8)}` as PaneId;
}

export function createTabId(prefix = "tab"): TabId {
  return `${prefix}.${crypto.randomUUID().slice(0, 8)}` as TabId;
}
