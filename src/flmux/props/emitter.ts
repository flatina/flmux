export type EventListener = (...args: unknown[]) => void;

export class TypedEmitter {
  private readonly listeners = new Map<string, Set<EventListener>>();

  on(eventType: string, listener: EventListener): () => void {
    const bucket = this.listeners.get(eventType) ?? new Set<EventListener>();
    bucket.add(listener);
    this.listeners.set(eventType, bucket);
    return () => {
      this.off(eventType, listener);
    };
  }

  off(eventType: string, listener: EventListener): void {
    const bucket = this.listeners.get(eventType);
    if (!bucket) {
      return;
    }
    bucket.delete(listener);
    if (bucket.size === 0) {
      this.listeners.delete(eventType);
    }
  }

  once(eventType: string, listener: EventListener): () => void {
    const off = this.on(eventType, (...args) => {
      off();
      listener(...args);
    });
    return off;
  }

  emit(eventType: string, ...args: unknown[]): void {
    const bucket = this.listeners.get(eventType);
    if (!bucket) {
      return;
    }

    for (const listener of [...bucket]) {
      try {
        listener(...args);
      } catch {
        // one bad listener must not break the others
      }
    }
  }

  disposeEmitter(): void {
    this.listeners.clear();
  }
}
