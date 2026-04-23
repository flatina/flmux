import type { ChannelHandle, TransportDemuxer } from "bunite-core/view";

// Renderer-side demuxer for extension pane channels. `main.ts` installs it
// after wiring the default channel to the ShellModelAPI rpc; every extension
// pane claims its own `ChannelHandle` via `channelForPane(paneId)` during
// mount and awaits `channel.bindTo(rpc)` before the first request.

let demuxer: TransportDemuxer | null = null;

export function setExtensionPaneDemuxer(next: TransportDemuxer): void {
  demuxer = next;
}

export function channelForPane(paneId: string): ChannelHandle | undefined {
  return demuxer?.channel(paneId);
}
