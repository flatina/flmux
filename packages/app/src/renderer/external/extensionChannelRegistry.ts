import type { RpcChannelHandle, RpcTransportDemuxer } from "bunite-core/view";

// Renderer-side demuxer for extension RPC channels. Channel name is
// `<extId>:<name>`, namespaced by extension. Bind once per (ext × name) —
// typically in `defineExtension({ onLoad })` for eager handshake before any
// pane mount; module-level guard inside `mount` for lazy alternative.

let demuxer: RpcTransportDemuxer | null = null;

export function setExtensionDemuxer(next: RpcTransportDemuxer): void {
  demuxer = next;
}

export function channelForExtension(extensionId: string, name = "default"): RpcChannelHandle {
  if (!demuxer) {
    throw new Error("extension demuxer not installed — set via setExtensionDemuxer at bootstrap");
  }
  return demuxer.channel(`${extensionId}:${name}`);
}
