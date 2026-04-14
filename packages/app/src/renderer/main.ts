import { registerLocalExternalPaneDescriptors } from "./external/registerLocalExternalPaneDescriptors";
import { FlmuxWorkbench, type FlmuxRendererConfig } from "./shell/workbench";
import { installRendererShellModelBridge } from "./rendererBridge";

declare global {
  interface Window {
    bunite?: { invoke: (method: string, params?: unknown) => Promise<unknown> };
  }
}

void bootstrap().catch((error) => {
  document.body.innerHTML = `<pre class="fatal">${String(error)}</pre>`;
});

async function bootstrap() {
  const invoke = window.bunite?.invoke;
  if (!invoke) {
    throw new Error("bunite runtime not available on local HTTP page");
  }

  const config = (await invoke("flmux.getConfig")) as FlmuxRendererConfig;
  const workbench = new FlmuxWorkbench(config);
  registerLocalExternalPaneDescriptors(workbench);
  await workbench.start();
  installRendererShellModelBridge(workbench.shellModel);

  await invoke("flmux.client.register");
}
