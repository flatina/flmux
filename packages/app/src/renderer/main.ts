import { BuniteView } from "bunite-core/view";
import type { FlmuxRendererBridgeSchema } from "../shared/rendererBridge";
import type { TerminalRuntimeEvent } from "../shared/terminal";
import type { SequencedShellCoreEvent } from "@flmux/core/shell";
import { registerLocalExternalPaneDescriptors } from "./external/registerLocalExternalPaneDescriptors";
import { FlmuxWorkbench } from "./shell/workbench";
import { pushShellCoreEvent } from "./shell/shellEventBus";
import { pushTerminalEvent } from "./terminalHost";
import { FlmuxWebModeClient } from "./webModeClient";

void bootstrap().catch((error) => {
  document.body.innerHTML = `<pre class="fatal">${String(error)}</pre>`;
});

async function bootstrap() {
  const rpc = BuniteView.defineRPC<FlmuxRendererBridgeSchema>({
    handlers: {
      messages: {
        "terminal.event": (event: TerminalRuntimeEvent) => {
          pushTerminalEvent(event);
        },
        "shellCore.event": (event: SequencedShellCoreEvent) => {
          pushShellCoreEvent(event);
        }
      }
    }
  });

  const config = await rpc.requestProxy["flmux.getConfig"]();
  if (config.mode === "web") {
    const webClient = new FlmuxWebModeClient(config);
    await webClient.start();
    return;
  }

  const workbench = new FlmuxWorkbench(config, rpc.requestProxy);
  await registerLocalExternalPaneDescriptors(workbench, config.localExtensions);

  await rpc.requestProxy["flmux.client.register"]();
  await workbench.start();
}
