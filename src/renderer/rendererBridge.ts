import { BuniteView } from "bunite-core/view";
import type { ShellModelAPI } from "./shell/types";
import { pushTerminalEvent } from "./terminalHost";
import type {
  FlmuxRendererBridgeSchema,
  RendererShellModelRequestMap
} from "../shared/rendererBridge";
import type { TerminalRuntimeEvent } from "../shared/terminal";

export function installRendererShellModelBridge(shellModel: ShellModelAPI) {
  const rpc = BuniteView.defineRPC<FlmuxRendererBridgeSchema>({
    handlers: {
      messages: {
        "terminal.event": (event: TerminalRuntimeEvent) => {
          pushTerminalEvent(event);
        }
      } as any,
      requests: {
        "shellModel.path.get": (params: RendererShellModelRequestMap["shellModel.path.get"]["params"]) =>
          shellModel.pathGet(params.path),
        "shellModel.path.list": (params: RendererShellModelRequestMap["shellModel.path.list"]["params"]) =>
          shellModel.pathList(params.path),
        "shellModel.path.set": (params: RendererShellModelRequestMap["shellModel.path.set"]["params"]) =>
          shellModel.pathSet(params.path, params.value),
        "shellModel.path.call": (params: RendererShellModelRequestMap["shellModel.path.call"]["params"]) =>
          shellModel.pathCall(params.path, params.args)
      } as any
    }
  });

  return new BuniteView({ rpc });
}
