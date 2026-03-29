import type {
  RendererRpcMethod,
  RendererRpcParams,
  RendererRpcRequestProxy,
  RendererRpcResult
} from "../rpc/renderer-rpc";

type WindowWithRendererRpc = {
  webview: {
    rpc?: unknown;
  };
};

export class RendererWorkspaceBridge {
  private cdpBaseUrl: string | null = null;

  constructor(private readonly getWindow: () => WindowWithRendererRpc) {}

  setCdpBaseUrl(url: string | null): void {
    this.cdpBaseUrl = url;
  }

  getCdpBaseUrl(): string | null {
    return this.cdpBaseUrl;
  }

  request<Method extends RendererRpcMethod>(
    method: Method,
    params: RendererRpcParams<Method>
  ): Promise<RendererRpcResult<Method>> {
    return this.getRequestProxy()[method](params);
  }

  private getRequestProxy(): RendererRpcRequestProxy {
    const rpc = this.getWindow().webview.rpc as { request?: RendererRpcRequestProxy } | undefined;
    if (!rpc?.request) {
      throw new Error("Renderer RPC is not ready");
    }
    return rpc.request;
  }
}
