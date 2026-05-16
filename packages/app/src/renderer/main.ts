import { bootstrap as bootstrapCap } from "bunite-core/rpc/renderer";
import { shellCap } from "../shared/rendererBridge";
import { registerLocalExternalPaneDescriptors } from "./external/registerLocalExternalPaneDescriptors";
import { FlmuxWorkbench } from "./shell/workbench";
import { setupTheme } from "./theme";

void bootstrap().catch((error) => {
  document.body.innerHTML = `<pre class="fatal">${String(error)}</pre>`;
});

async function bootstrap() {
  setupTheme();
  const shell = await bootstrapCap(shellCap);
  // Workbench owns the `shell.events()` lifecycle — opens it after
  // registerClient (server-side stream impl needs the bound clientId).
  const config = await shell.getConfig();
  const workbench = new FlmuxWorkbench(config, shell);
  const fireExtensionOnLoad = await registerLocalExternalPaneDescriptors(workbench, config.localExtensions);
  await workbench.start();
  // After registerClient resolves, server-side `onClientConnected` has had a
  // chance to serve each extension's cap — safe for extensions to bootstrap.
  fireExtensionOnLoad();

  if (config.devMode) {
    (
      window as unknown as {
        __flmuxTest: { setActiveWorkspace(id: string): void };
      }
    ).__flmuxTest = {
      setActiveWorkspace: (id: string) => workbench.setActiveWorkspace(id)
    };
  }
}

