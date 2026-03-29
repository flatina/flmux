import Electrobun, { Electroview } from "electrobun/view";
import type {
  HostPushMessage,
  HostPushPayload,
  HostRpc,
  HostRpcMethod,
  HostRpcParams,
  HostRpcResult
} from "../../rpc/host-rpc";
import type { MainviewRpcSchema } from "../../rpc/mainview-rpc";
import type {
  RendererPushMessage,
  RendererPushPayload,
  RendererRpcRequestHandlers
} from "../../rpc/renderer-rpc";

const rpc = Electroview.defineRPC<MainviewRpcSchema>({
  maxRequestTime: 15_000,
  handlers: {
    requests: {},
    messages: {}
  }
});

const electrobun = new Electrobun.Electroview({ rpc });

export function setRendererRpcHandlers(handlers: RendererRpcRequestHandlers): void {
  rpc.setRequestHandler(handlers);
}

export function sendRendererRpcMessage<Message extends RendererPushMessage>(
  message: Message,
  payload: RendererPushPayload<Message>
): void {
  const rawRpc = getRawRpc();
  const send = rawRpc.send?.[message];
  if (!send) {
    throw new Error(`Renderer RPC message is not available: ${String(message)}`);
  }
  send(payload);
}

export function getHostRpc(): HostRpc {
  return {
    async request<Method extends HostRpcMethod>(
      method: Method,
      params: HostRpcParams<Method>
    ): Promise<HostRpcResult<Method>> {
      const request = getRawRpc().request[method];
      if (!request) {
        throw new Error(`Host RPC method is not available: ${method}`);
      }

      return request((params ?? {}) as unknown) as Promise<HostRpcResult<Method>>;
    },
    subscribe<Message extends HostPushMessage>(
      message: Message,
      handler: (payload: HostPushPayload<Message>) => void
    ): () => void {
      const rawRpc = getRawRpc();
      const listener = (payload: unknown) => handler(payload as HostPushPayload<Message>);
      rawRpc.addMessageListener(message as string, listener);
      return () => rawRpc.removeMessageListener(message as string, listener);
    }
  };
}

function getRawRpc(): {
  request: Record<string, (params: unknown) => Promise<unknown>>;
  send?: Record<string, (payload: unknown) => void>;
  addMessageListener: (message: string, handler: (payload: unknown) => void) => void;
  removeMessageListener: (message: string, handler: (payload: unknown) => void) => void;
} {
  if (!electrobun.rpc) {
    throw new Error("Electrobun RPC is not ready");
  }

  return electrobun.rpc as unknown as {
    request: Record<string, (params: unknown) => Promise<unknown>>;
    send?: Record<string, (payload: unknown) => void>;
    addMessageListener: (message: string, handler: (payload: unknown) => void) => void;
    removeMessageListener: (message: string, handler: (payload: unknown) => void) => void;
  };
}
