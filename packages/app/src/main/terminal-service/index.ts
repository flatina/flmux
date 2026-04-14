import type { TerminalBackend } from "./backend";
import { createInMemoryTerminalBackend } from "./inMemoryBackend";
import { createPtydBackend } from "./ptydBackend";

export interface TerminalService extends TerminalBackend {}

export function createTerminalService(backend: TerminalBackend = createPtydBackend()): TerminalService {
  return {
    adoptByPaneId: (input) => backend.adoptByPaneId(input),
    create: (input) => backend.create(input),
    write: (input) => backend.write(input),
    history: (input) => backend.history(input),
    kill: (input) => backend.kill(input),
    listRoots: () => backend.listRoots(),
    subscribe: (handler) => backend.subscribe(handler),
    dispose: () => backend.dispose?.()
  };
}

export type { TerminalBackend } from "./backend";
export { createInMemoryTerminalBackend } from "./inMemoryBackend";
export { createPtydBackend } from "./ptydBackend";
