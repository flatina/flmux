import type { RpcChannelHandle, RpcTransportDemuxer } from "bunite-core/view";

// Renderer-side demuxer for extension pane channels. `main.ts` installs it
// after wiring the default channel to the ShellModelAPI rpc; every extension
// pane claims its own `RpcChannelHandle` via `channelForPane(paneId)` and
// awaits `rpcChannel.bindTo(rpc)` before the first request.

let demuxer: RpcTransportDemuxer | null = null;

export function setExtensionPaneDemuxer(next: RpcTransportDemuxer): void {
  demuxer = next;
}

export function channelForPane(paneId: string): RpcChannelHandle | undefined {
  return demuxer?.channel(paneId);
}
