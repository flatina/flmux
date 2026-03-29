import type { SessionId } from "../../lib/ids";
import type { BrowserPaneAdapter, TerminalRenderer } from "./pane-params";
import type { TerminalRuntimeSummary } from "../../types/terminal";
import type { ThemePreference } from "../../types/view";

export type TerminalRuntimeOwner = "ptyd" | "embedded" | "none";

export interface ExtensionSetupModule {
  id: string;
  source?: string;
}

export interface BootstrapState {
  sessionId: SessionId;
  platform: string;
  cwd: string;
  browserPaneDefaultAdapter: BrowserPaneAdapter;
  terminalRendererDefault: TerminalRenderer;
  liveTerminalRuntimes: TerminalRuntimeSummary[];
  terminalRuntimeOwner: TerminalRuntimeOwner;
  extensionSetups: ExtensionSetupModule[];
  restoreLayout: boolean;
  webServerUrl: string | null;
  uiTheme: ThemePreference;
  browserAutomation: {
    cdpBaseUrl: string | null;
  };
}
