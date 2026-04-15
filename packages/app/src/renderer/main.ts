import { BuniteView } from "bunite-core/view";
import type { FlmuxRendererBridgeSchema } from "../shared/rendererBridge";
import type { TerminalRuntimeEvent } from "../shared/terminal";
import { registerLocalExternalPaneDescriptors } from "./external/registerLocalExternalPaneDescriptors";
import { FlmuxWorkbench } from "./shell/workbench";
import { pushTerminalEvent } from "./terminalHost";

void bootstrap().catch((error) => {
  document.body.innerHTML = `<pre class="fatal">${String(error)}</pre>`;
});

async function bootstrap() {
  const rpc = BuniteView.defineRPC<FlmuxRendererBridgeSchema>({
    handlers: {
      messages: {
        "terminal.event": (event: TerminalRuntimeEvent) => {
          pushTerminalEvent(event);
        }
      }
    }
  });

  const config = await rpc.requestProxy["flmux.getConfig"]();
  const workbench = new FlmuxWorkbench(config, rpc.requestProxy);
  await registerLocalExternalPaneDescriptors(workbench, config.localExtensions);
  await workbench.start();

  rpc.setRequestHandler({
    "shellModel.path.get": (params) => workbench.shellModel.pathGet(params.path),
    "shellModel.path.list": (params) => workbench.shellModel.pathList(params.path),
    "shellModel.path.set": (params) => workbench.shellModel.pathSet(params.path, params.value),
    "shellModel.path.call": (params) => workbench.shellModel.pathCall(params.path, params.args)
  });

  await rpc.requestProxy["flmux.client.register"]();
}
