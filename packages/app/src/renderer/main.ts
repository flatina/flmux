import "bunite-core/polyfill";
import { bootstrap as bootstrapCap, getConnection, type BuniteWebGlobal } from "bunite-core/rpc/renderer";
import { flmuxBridgeCap, paneBrowserCap, type FlmuxBridgeCap, type SessionCap } from "../shared/rendererBridge";
import { installConnectionLossOverlay, showConnectionLoss } from "./connectionOverlay";
import { registerLocalExternalPaneDescriptors } from "./external/registerLocalExternalPaneDescriptors";
import { createPaneBrowserCapImpl } from "./panes/browserPaneRegistry";
import { FlmuxWorkbench } from "./shell/workbench";
import { setupTheme } from "./theme";

declare global {
  interface Window {
    __bunite?: BuniteWebGlobal;
  }
}

const SESSION_COOKIE = "flmux-session";

void bootstrap().catch((error) => {
  document.body.innerHTML = `<pre class="fatal">${String(error)}</pre>`;
});

// Token is already in the `flmux_web_token` cookie; drop it from the URL so it
// doesn't linger in history/referrer.
function stripAuthTokenFromUrl() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("token")) return;
  url.searchParams.delete("token");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}

async function bootstrap() {
  stripAuthTokenFromUrl();
  setupTheme();
  // Cross-bundle conn share — 0-externals extension bundles each inline bunite-core.
  const conn = await getConnection();
  window.__bunite = { ...(window.__bunite ?? {}), webConnection: conn };
  // Surface WS loss (server restart / network drop) instead of freezing silently.
  installConnectionLossOverlay(conn);
  // Serve paneBrowserCap before bridge so main's automation calls during
  // session bind cannot race ahead of cap registration.
  conn.serve(paneBrowserCap, createPaneBrowserCapImpl());
  const bridge = await bootstrapCap(flmuxBridgeCap);

  // Resume continuity: cookie holds previous session's resumeToken. Try first;
  // fall through to createSession on miss/expiry.
  const resumeToken = readCookie(SESSION_COOKIE);
  let session: SessionCap;
  if (resumeToken) {
    try {
      session = await bridge.resumeSession({ resumeToken });
    } catch {
      session = await mintSession(bridge);
    }
  } else {
    session = await mintSession(bridge);
  }

  const config = await session.getConfig();
  const workbench = new FlmuxWorkbench(config, session);
  const fireExtensionOnLoad = await registerLocalExternalPaneDescriptors(workbench, config.localExtensions);
  // Fire onLoad BEFORE start so restored panes that mount during workbench.start
  // (bootstrap snapshot replay) find their extension cap already bootstrapping.
  fireExtensionOnLoad();
  await workbench.start();

  if (config.devMode) {
    (
      window as unknown as {
        __flmuxTest: { setActiveWorkspace(id: string): void; simulateConnectionLoss(): void };
      }
    ).__flmuxTest = {
      setActiveWorkspace: (id: string) => workbench.setActiveWorkspace(id),
      simulateConnectionLoss: () => showConnectionLoss()
    };
  }
}

async function mintSession(bridge: FlmuxBridgeCap): Promise<SessionCap> {
  // Mode detection: preload (CEF) gets attestation `app-internal`. The bridge
  // method enforces it; on web the call errors and falls through to web mint.
  try {
    return await bridge.createDesktopSession();
  } catch {
    return await bridge.createSession();
  }
}

function readCookie(name: string): string | null {
  const match = document.cookie.split("; ").find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}
