import type { TerminalRenderer } from "../types/terminal";
export type { TerminalRenderer, TerminalRuntimeStatus, TerminalRuntimeSummary, TerminalRuntimeEvent } from "../types/terminal";

export function isTerminalRenderer(value: unknown): value is TerminalRenderer {
  return value === "xterm" || value === "ghostty";
}
