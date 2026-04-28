import { BuniteView, createRpcTransportDemuxer, defineWebviewRpc } from "bunite-core/view";
import type { FlmuxRendererBridgeSchema } from "../shared/rendererBridge";
import type { TerminalRuntimeEvent } from "@flmux/core/terminal/types";
import type { SequencedShellCoreEvent } from "@flmux/core/shell";
import { registerLocalExternalPaneDescriptors } from "./external/registerLocalExternalPaneDescriptors";
import { setExtensionPaneDemuxer } from "./external/paneChannelRegistry";
import { FlmuxWorkbench } from "./shell/workbench";
import { pushShellCoreEvent } from "./shell/shellEventBus";
import { pushTerminalEvent } from "./terminalHost";
import { setupTheme } from "./theme";

void bootstrap().catch((error) => {
  document.body.innerHTML = `<pre class="fatal">${String(error)}</pre>`;
});

async function bootstrap() {
  setupTheme();
  const rpc = defineWebviewRpc<FlmuxRendererBridgeSchema>({
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
  const view = new BuniteView();
  const demux = createRpcTransportDemuxer(view.transport);
  // Await the HELLO handshake before any request is sent — `getConfig()`
  // below races the peer's handler registration without this.
  await demux.channel("default").bindTo(rpc);
  // Expose to external pane runtime so extension panes can claim their own
  // channel via `ctx.rpcChannel.bindTo(rpc)` on mount.
  setExtensionPaneDemuxer(demux);

  const config = await rpc.requestProxy["flmux.getConfig"]();
  const workbench = new FlmuxWorkbench(config, rpc.requestProxy);
  await registerLocalExternalPaneDescriptors(workbench, config.localExtensions);
  // Register + bootstrap live inside `workbench.start()` — ordering differs
  // by mode (desktop: register→bootstrap so the forwarder is up for events
  // emitted during bootstrap; web: HTTP bootstrap→register so the server
  // has an attachmentId before it can install the forwarder).
  await workbench.start();

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
