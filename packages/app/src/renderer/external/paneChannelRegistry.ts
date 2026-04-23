import type { RPCTransport } from "bunite-core/shared/rpc";
import type { TransportDemuxer } from "bunite-core/view";

// Renderer-side demuxer for extension pane channels. `main.ts` installs it
// after wiring the default channel to the ShellModelAPI rpc; every extension
// pane pulls its own channel via `channelForPane(paneId)` during mount.

let demuxer: TransportDemuxer | null = null;

export function setExtensionPaneDemuxer(next: TransportDemuxer): void {
  demuxer = next;
}

export function channelForPane(paneId: string): RPCTransport | undefined {
  return demuxer?.channel(paneId);
}
