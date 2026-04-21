import type { WorkspaceBus, WorkspaceBusEvent } from "./types";

interface Subscription {
  topic: string;
  handler: (event: WorkspaceBusEvent) => void;
}

export function createWorkspaceBus(workspaceId: string): WorkspaceBus {
  const subscriptions = new Set<Subscription>();

  return {
    publish(event) {
      if (event.workspaceId !== workspaceId) {
        throw new Error(`WorkspaceBus scope mismatch: expected '${workspaceId}', received '${event.workspaceId}'`);
      }

      for (const subscription of subscriptions) {
        if (!matchesTopic(subscription.topic, event.topic)) {
          continue;
        }

        try {
          subscription.handler(event);
        } catch (error) {
          console.warn("workspace bus subscriber failed", {
            workspaceId,
            topic: event.topic,
            error
          });
        }
      }
    },

    subscribe(topic, handler) {
      const subscription: Subscription = {
        topic,
        handler: (event) => handler(event as WorkspaceBusEvent<unknown> as WorkspaceBusEvent<any>)
      };
      subscriptions.add(subscription);
      return () => {
        subscriptions.delete(subscription);
      };
    }
  };
}

function matchesTopic(pattern: string, topic: string): boolean {
  if (pattern === "*") {
    return true;
  }

  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1);
    return topic.startsWith(prefix);
  }

  return pattern === topic;
}
