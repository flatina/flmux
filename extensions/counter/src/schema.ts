// Shared type between the server entry and the renderer pane. The extension
// owns this schema — flmux only routes the transport channel; it never
// inspects the payload.
//
// `bun` side = server (main process). `webview` side = renderer (per pane).
// Each side declares the requests it handles + the messages the other side
// sends to it.

export type CounterSchema = {
  bun: {
    requests: {
      getCount: { params: undefined; response: { count: number } };
      increment: { params: { delta?: number }; response: { count: number } };
      reset: { params: undefined; response: { count: number } };
    };
    messages: {
      /** Pushed to every pane after the server-held count changes. */
      "count.changed": { count: number; sourcePaneId: string | null };
    };
  };
  webview: {
    requests: {};
    messages: {};
  };
};
