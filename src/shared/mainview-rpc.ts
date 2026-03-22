import type { RPCSchema } from "electrobun/bun";
import type { HostPushMessageMap, HostRpcMethodMap } from "./host-rpc";
import type { RendererPushMessageMap, RendererRpcMethodMap } from "./renderer-rpc";

type ToRequestSchema<Methods> = {
  [Method in keyof Methods]: Methods[Method] extends {
    params: infer Params;
    result: infer Result;
  }
    ? {
        params: Params;
        response: Result;
      }
    : never;
};

export type MainviewRpcSchema = {
  bun: RPCSchema<{
    requests: ToRequestSchema<HostRpcMethodMap>;
    messages: HostPushMessageMap;
  }>;
  webview: RPCSchema<{
    requests: ToRequestSchema<RendererRpcMethodMap>;
    messages: RendererPushMessageMap;
  }>;
};
