// Electrobun build uses this directly.
// Web build swaps this module for ws-rpc.ts via Bun.build plugin.
export { getHostRpc, setRendererRpcHandlers } from "./electrobun-rpc";
