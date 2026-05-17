import { bootstrap as bootstrapCap } from "bunite-core/rpc/renderer";
import { flmuxBridgeCap, type FlmuxBridgeCap, type SessionCap } from "../shared/rendererBridge";
import { registerLocalExternalPaneDescriptors } from "./external/registerLocalExternalPaneDescriptors";
import { FlmuxWorkbench } from "./shell/workbench";
import { setupTheme } from "./theme";

const SESSION_COOKIE = "flmux-session";

void bootstrap().catch((error) => {
  document.body.innerHTML = `<pre class="fatal">${String(error)}</pre>`;
});

async function bootstrap() {
  setupTheme();
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
    (window as unknown as { __flmuxTest: { setActiveWorkspace(id: string): void } }).__flmuxTest = {
      setActiveWorkspace: (id: string) => workbench.setActiveWorkspace(id)
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
