import type { ExtensionRegistryEntry } from "./extension-spi";
import type { SessionId } from "./ids";
import type { BrowserPaneAdapter, TerminalRenderer } from "./pane-params";
import type { TerminalRuntimeSummary } from "./rpc";

export type TerminalRuntimeOwner = "ptyd" | "embedded" | "none";

export interface BootstrapState {
  sessionId: SessionId;
  platform: string;
  cwd: string;
  browserPaneDefaultAdapter: BrowserPaneAdapter;
  terminalRendererDefault: TerminalRenderer;
  liveTerminalRuntimes: TerminalRuntimeSummary[];
  terminalRuntimeOwner: TerminalRuntimeOwner;
  extensions: ExtensionRegistryEntry[];
  restoreLayout: boolean;
  webServerUrl: string | null;
  browserAutomation: {
    cdpBaseUrl: string | null;
  };
}
