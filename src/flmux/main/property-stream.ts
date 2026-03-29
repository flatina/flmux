import { createServer, type Server, type Socket } from "node:net";
import type { PropertyChangeEvent } from "../../types/property";
import { cleanupIpcListenerPath, prepareIpcListenerPath } from "../../lib/ipc/ipc-socket";
import { toJsonLine } from "../../lib/ipc/json-lines";

export interface PropertyStreamServer {
  ipcPath: string;
  publish: (event: PropertyChangeEvent) => void;
  stop: () => Promise<void>;
}

export async function startPropertyStreamServer(ipcPath: string): Promise<PropertyStreamServer> {
  await prepareIpcListenerPath(ipcPath);
  const subscribers = new Set<Socket>();

  const server = createServer((socket) => {
    subscribers.add(socket);
    socket.on("close", () => {
      subscribers.delete(socket);
    });
    socket.on("error", () => {
      subscribers.delete(socket);
      socket.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(ipcPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    ipcPath,
    publish(event) {
      const payload = toJsonLine(event);
      for (const subscriber of subscribers) {
        try {
          subscriber.write(payload);
        } catch {
          subscriber.destroy();
          subscribers.delete(subscriber);
        }
      }
    },
    stop: async () => {
      await stopPropertyStreamServer(server, ipcPath, subscribers);
    }
  };
}

async function stopPropertyStreamServer(server: Server, ipcPath: string, subscribers: Set<Socket>): Promise<void> {
  for (const subscriber of subscribers) {
    subscriber.destroy();
  }
  subscribers.clear();

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  await cleanupIpcListenerPath(ipcPath);
}
