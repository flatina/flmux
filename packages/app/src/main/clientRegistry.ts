import type { FlmuxRendererBridge } from "../shared/rendererBridge";

interface FlmuxClientRecord {
  clientId: string | null;
  viewId: number;
  bridge: FlmuxRendererBridge;
}

export interface RegisteredFlmuxClient {
  clientId: string;
  viewId: number;
  bridge: FlmuxRendererBridge;
}

export class FlmuxClientRegistry {
  private readonly byClientId = new Map<string, FlmuxClientRecord>();
  private readonly byViewId = new Map<number, FlmuxClientRecord>();

  attachRenderer(viewId: number, bridge: FlmuxRendererBridge) {
    const existing = this.byViewId.get(viewId);
    if (existing) {
      existing.bridge = bridge;
      return;
    }

    this.byViewId.set(viewId, {
      clientId: null,
      viewId,
      bridge
    });
  }

  registerRenderer(viewId: number): RegisteredFlmuxClient {
    const record = this.byViewId.get(viewId);
    if (!record) {
      throw new Error(`No renderer is attached for viewId=${viewId}`);
    }

    if (!record.clientId) {
      record.clientId = `client_${crypto.randomUUID()}`;
      this.byClientId.set(record.clientId, record);
    }

    return toRegisteredClient(record);
  }

  resolve(clientId: string): RegisteredFlmuxClient {
    const record = this.byClientId.get(clientId);
    if (!record?.clientId) {
      throw new Error(`Unknown flmux client: ${clientId}`);
    }

    return toRegisteredClient(record);
  }

  list(): RegisteredFlmuxClient[] {
    return [...this.byClientId.values()].map((record) => toRegisteredClient(record));
  }

  resolveByViewId(viewId: number): RegisteredFlmuxClient | null {
    const record = this.byViewId.get(viewId);
    if (!record?.clientId) {
      return null;
    }

    return toRegisteredClient(record);
  }

  detachRenderer(viewId: number) {
    const record = this.byViewId.get(viewId);
    if (!record) {
      return;
    }

    this.byViewId.delete(viewId);
    if (record.clientId) {
      this.byClientId.delete(record.clientId);
    }
  }
}

function toRegisteredClient(record: FlmuxClientRecord): RegisteredFlmuxClient {
  if (!record.clientId) {
    throw new Error(`Renderer viewId=${record.viewId} has not registered a clientId yet`);
  }

  return {
    clientId: record.clientId,
    viewId: record.viewId,
    bridge: record.bridge
  };
}
