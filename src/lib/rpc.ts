export interface RpcEndpoint {
  ipcPath: string;
}

export class RpcDispatcher<Handlers extends Record<string, (params: never) => unknown>> {
  constructor(readonly handlers: Handlers) {}

  invoke(method: string, params: unknown): Promise<unknown> {
    const handler = this.handlers[method as keyof Handlers];
    if (!handler) return Promise.reject(new Error(`Unknown method: ${method}`));
    return Promise.resolve((handler as (params: unknown) => unknown)(params));
  }
}
