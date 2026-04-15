export interface PaneStateStore {
  getParams<T extends Record<string, unknown> = Record<string, unknown>>(): T;
  setParams(nextParams: Record<string, unknown>): void;
  patchParams(nextParams: Record<string, unknown>): void;
  getTitle(): string | undefined;
  setTitle(title: string): void;
}
