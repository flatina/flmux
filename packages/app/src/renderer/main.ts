import { BuniteView } from "bunite-core/view";
import type { FlmuxRendererBridgeSchema } from "../shared/rendererBridge";
import type { TerminalRuntimeEvent } from "../shared/terminal";
import type { SequencedShellCoreEvent } from "@flmux/core/shell";
import { registerLocalExternalPaneDescriptors } from "./external/registerLocalExternalPaneDescriptors";
import { FlmuxWorkbench } from "./shell/workbench";
import { pushShellCoreEvent } from "./shell/shellEventBus";
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
        },
        "shellCore.event": (event: SequencedShellCoreEvent) => {
          pushShellCoreEvent(event);
        }
      }
    }
  });

  const config = await rpc.requestProxy["flmux.getConfig"]();
  const workbench = new FlmuxWorkbench(config, rpc.requestProxy);
  await registerLocalExternalPaneDescriptors(workbench, config.localExtensions);
  // Register + bootstrap live inside `workbench.start()` — ordering differs
  // by mode (desktop: register→bootstrap so the forwarder is up for events
  // emitted during bootstrap; web: HTTP bootstrap→register so the server
  // has an attachmentId before it can install the forwarder).
  await workbench.start();

  if (config.devMode) {
    (window as unknown as {
      __flmuxTest: { setActiveWorkspace(id: string): void };
    }).__flmuxTest = {
      setActiveWorkspace: (id: string) => workbench.setActiveWorkspace(id)
    };
  }
}
