import { asPaneId, asTabId, type PaneId, type TabId } from "../shared/ids";

/** Sentinel owner for app-level subscriptions (not tied to a specific pane/tab). */
export const AppOwner = {
  paneId: asPaneId("__app__"),
  tabId: asTabId("__app__")
} as const;

export interface PaneEvent {
  source: PaneId;
  tabId: TabId;
  type: string;
  data: unknown;
  timestamp: number;
}

export interface EventSubscriptionOptions {
  global?: boolean;
}

interface Subscription {
  eventType: string;
  handler: (event: PaneEvent) => void;
  ownerPaneId: PaneId;
  ownerTabId: TabId;
  global: boolean;
}

export class EventBus {
  private readonly subscriptions: Subscription[] = [];

  emit(source: PaneId, tabId: TabId, eventType: string, data: unknown): void {
    const event: PaneEvent = {
      source,
      tabId,
      type: eventType,
      data,
      timestamp: Date.now()
    };

    for (const sub of this.subscriptions) {
      if (sub.eventType !== eventType) continue;
      if (!sub.global && sub.ownerTabId !== tabId) continue;

      try {
        sub.handler(event);
      } catch {
        // error boundary: one bad handler must not crash the bus
      }
    }
  }

  on(
    ownerPaneId: PaneId,
    ownerTabId: TabId,
    eventType: string,
    handler: (event: PaneEvent) => void,
    options?: EventSubscriptionOptions
  ): () => void {
    const sub: Subscription = {
      eventType,
      handler,
      ownerPaneId: ownerPaneId,
      ownerTabId: ownerTabId,
      global: options?.global ?? false
    };

    this.subscriptions.push(sub);

    return () => {
      const idx = this.subscriptions.indexOf(sub);
      if (idx >= 0) this.subscriptions.splice(idx, 1);
    };
  }

  /** Remove all subscriptions owned by a pane (called on pane dispose). */
  disposePane(paneId: PaneId): void {
    for (let i = this.subscriptions.length - 1; i >= 0; i--) {
      if (this.subscriptions[i].ownerPaneId === paneId) {
        this.subscriptions.splice(i, 1);
      }
    }
  }

  /** Remove all subscriptions. */
  dispose(): void {
    this.subscriptions.length = 0;
  }
}
