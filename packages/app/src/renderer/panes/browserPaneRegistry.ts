import { Stream } from "bunite-core/rpc";
import { getConnection } from "bunite-core/rpc/renderer";
import type {
  BrowserPaneAccessibilitySnapshotResult,
  BrowserPaneBoundingRectResult,
  BrowserPaneCapabilities,
  BrowserPaneConsoleEntry,
  BrowserPaneDialogEvent,
  BrowserPaneDownloadEvent,
  BrowserPaneDownloadPolicy,
  BrowserPaneEvaluateResult,
  BrowserPaneListFramesResult,
  BrowserPaneModifier,
  BrowserPaneNavigationState,
  BrowserPaneResolveAndClickResult,
  BrowserPaneScreenshotResult,
  BrowserPaneSurfaceEvent,
  BrowserPaneWaitForDownloadResult,
  BrowserPaneWaitResult,
  PaneBrowserCapImpl
} from "../../shared/rendererBridge";

// `<bunite-webview>` automation surface — methods we route + internal
// surfaceId for stream subscriptions bunite doesn't dispatch as DOM events
// (consoleEvents, dialogs, acceptPopup).
export interface BuniteWebviewAutomationElement extends HTMLElement {
  _surfaceId: number | null;

  // Stage A-D
  evaluate(script: string, opts?: { frameId?: string }): Promise<BrowserPaneEvaluateResult>;
  sendClick(args: {
    x: number;
    y: number;
    button?: "left" | "middle" | "right";
    clickCount?: number;
    modifiers?: BrowserPaneModifier[];
  }): Promise<void>;
  sendType(text: string): Promise<void>;
  sendPress(key: string, modifiers?: BrowserPaneModifier[]): Promise<void>;
  sendScroll(args: {
    dx: number;
    dy: number;
    x?: number;
    y?: number;
    modifiers?: BrowserPaneModifier[];
  }): Promise<void>;
  screenshot(args?: { format?: "png" | "jpeg"; quality?: number }): Promise<BrowserPaneScreenshotResult>;
  capabilities(): Promise<BrowserPaneCapabilities>;
  goBack(): void;
  reload(): void;

  // Stage E
  sendMouse(args: {
    action: "move" | "down" | "up";
    x: number;
    y: number;
    button?: "left" | "middle" | "right";
    modifiers?: BrowserPaneModifier[];
  }): Promise<void>;
  respondToDialog(requestId: number, accept: boolean, text?: string): Promise<void>;
  setDialogTimeout(ms: number | null): Promise<void>;
  waitForSelector(selector: string, timeoutMs?: number): Promise<BrowserPaneWaitResult>;
  waitForFunction(
    expression: string,
    opts?: { timeoutMs?: number; pollIntervalMs?: number }
  ): Promise<BrowserPaneWaitResult>;
  getConsoleBuffer(opts?: { clear?: boolean }): Promise<BrowserPaneConsoleEntry[]>;

  // Stage F
  getNavigationState(): Promise<BrowserPaneNavigationState>;
  accessibilitySnapshot(opts?: {
    interestingOnly?: boolean;
  }): Promise<BrowserPaneAccessibilitySnapshotResult>;
  getBoundingRect(
    selector: string,
    opts?: { frameId?: string }
  ): Promise<BrowserPaneBoundingRectResult>;
  listFrames(): Promise<BrowserPaneListFramesResult>;
  setDownloadPolicy(policy: BrowserPaneDownloadPolicy, downloadDir?: string): Promise<void>;
  waitForDownload(opts?: { timeoutMs?: number }): Promise<BrowserPaneWaitForDownloadResult>;
  dismissPopup(newSurfaceId: number): Promise<void>;
  extendAdoptionTimeout(
    newSurfaceId: number,
    gracePeriodMs: number
  ): Promise<{ ok: true; deadlineMs: number } | { ok: false; code: string; message: string }>;
  resolveAndClick(
    selector: string,
    opts?: {
      frameId?: string;
      button?: "left" | "middle" | "right";
      clickCount?: number;
      modifiers?: BrowserPaneModifier[];
    }
  ): Promise<BrowserPaneResolveAndClickResult>;
}

const elements = new Map<string, BuniteWebviewAutomationElement>();

export function registerBrowserPaneElement(paneId: string, element: BuniteWebviewAutomationElement) {
  elements.set(paneId, element);
}

// Element-aware unregister — dockview can recycle paneIds; an old pane's
// `dispose` racing a new `init` would otherwise wipe the new entry.
export function unregisterBrowserPaneElement(paneId: string, element: BuniteWebviewAutomationElement) {
  if (elements.get(paneId) === element) elements.delete(paneId);
}

function requireElement(paneId: string): BuniteWebviewAutomationElement {
  const el = elements.get(paneId);
  if (!el) throw new Error(`browser pane '${paneId}' not registered (renderer not mounted)`);
  return el;
}

async function requireSurfaceId(paneId: string, timeoutMs = 5000): Promise<number> {
  // Both the element registration (Dockview mount of the pane panel) and the
  // surface id assignment land asynchronously after pane creation. Stream
  // subscriptions (dialogs/console/download) fire before either is ready when
  // the CLI immediately follows /panes/new with a state-touching op. Poll for
  // both via elements.get (non-throwing) instead of requireElement.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const el = elements.get(paneId);
    if (el && el._surfaceId != null) return el._surfaceId;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`browser pane '${paneId}': surface not ready after ${timeoutMs}ms`);
}

// SurfaceCap singleton — for streams bunite element doesn't re-dispatch as
// DOM events (`dialogs`, `consoleEvents`) and for `acceptPopup` which is not
// exposed as an element method.
type SurfaceCapProxy = {
  acceptPopup(args: {
    newSurfaceId: number;
    hostViewId: number;
    bounds: { x: number; y: number; width: number; height: number };
  }): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  dialogs(args: { surfaceId: number }): AsyncIterable<BrowserPaneDialogEvent> & { cancel?: () => void };
  consoleEvents(args: {
    surfaceId: number;
  }): AsyncIterable<BrowserPaneConsoleEntry> & { cancel?: () => void };
};

let surfaceCapPromise: Promise<SurfaceCapProxy> | null = null;
async function getRuntimeSurface(): Promise<SurfaceCapProxy> {
  if (!surfaceCapPromise) {
    surfaceCapPromise = (async () => {
      const conn = await getConnection();
      const runtime = conn.runtime();
      return (await runtime.surface()) as unknown as SurfaceCapProxy;
    })();
  }
  return surfaceCapPromise;
}

/** Stream bridge — wrap an async iterable from bunite SurfaceCap into a flmux
 * Stream. Cancels on abort. */
function bridgeBuniteStream<T>(
  signal: AbortSignal,
  iterable: AsyncIterable<T> & { cancel?: () => void },
  emit: (e: T) => void
) {
  signal.addEventListener("abort", () => iterable.cancel?.());
  void (async () => {
    try {
      for await (const event of iterable) {
        if (signal.aborted) break;
        emit(event);
      }
    } catch {
      /* stream torn down */
    }
  })();
}

export function createPaneBrowserCapImpl(): PaneBrowserCapImpl {
  return {
    // Stage A-D
    evaluate: ({ paneId, script, frameId }) => requireElement(paneId).evaluate(script, { frameId }),
    click: ({ paneId, ...args }) => requireElement(paneId).sendClick(args),
    type: ({ paneId, text }) => requireElement(paneId).sendType(text),
    press: ({ paneId, key, modifiers }) => requireElement(paneId).sendPress(key, modifiers),
    scroll: ({ paneId, ...args }) => requireElement(paneId).sendScroll(args),
    screenshot: ({ paneId, ...args }) => requireElement(paneId).screenshot(args),
    capabilities: ({ paneId }) => requireElement(paneId).capabilities(),
    goBack: ({ paneId }) => {
      requireElement(paneId).goBack();
    },
    reload: ({ paneId }) => {
      requireElement(paneId).reload();
    },

    // Stage E — calls
    mouse: ({ paneId, ...args }) => requireElement(paneId).sendMouse(args),
    respondToDialog: ({ paneId, requestId, accept, promptText }) =>
      requireElement(paneId).respondToDialog(requestId, accept, promptText),
    setDialogTimeout: ({ paneId, ms }) => requireElement(paneId).setDialogTimeout(ms),
    waitForSelector: ({ paneId, selector, timeoutMs }) =>
      requireElement(paneId).waitForSelector(selector, timeoutMs),
    waitForFunction: ({ paneId, expression, timeoutMs, pollIntervalMs }) =>
      requireElement(paneId).waitForFunction(expression, { timeoutMs, pollIntervalMs }),
    getConsoleBuffer: ({ paneId, clear }) => requireElement(paneId).getConsoleBuffer({ clear }),
    pressAction: ({ paneId, key, action, modifiers }) => {
      // Element exposes `sendPress(key, modifiers)` only — action variant comes
      // via direct SurfaceCap call when bunite element wraps it; for now route
      // through element's primary press for action="both", which is the same
      // semantics. down/up forwards via direct cap.
      const el = requireElement(paneId);
      if (action === "both") return el.sendPress(key, modifiers);
      // down|up — bunite element doesn't wrap; defer to TODO until needed.
      throw new Error(`pressAction action='${action}' not yet wired in renderer`);
    },

    // Stage E — streams
    dialogs: ({ paneId }) =>
      Stream.from<BrowserPaneDialogEvent>((emit, signal) => {
        void (async () => {
          try {
            const sid = await requireSurfaceId(paneId);
            const surface = await getRuntimeSurface();
            bridgeBuniteStream(signal, surface.dialogs({ surfaceId: sid }), emit);
          } catch (err) {
            signal.dispatchEvent(new Event("abort"));
          }
        })();
      }),
    consoleEvents: ({ paneId }) =>
      Stream.from<BrowserPaneConsoleEntry>((emit, signal) => {
        void (async () => {
          try {
            const sid = await requireSurfaceId(paneId);
            const surface = await getRuntimeSurface();
            bridgeBuniteStream(signal, surface.consoleEvents({ surfaceId: sid }), emit);
          } catch (err) {
            signal.dispatchEvent(new Event("abort"));
          }
        })();
      }),

    // Stage F — calls
    getNavigationState: ({ paneId }) => requireElement(paneId).getNavigationState(),
    accessibilitySnapshot: ({ paneId, interestingOnly }) =>
      requireElement(paneId).accessibilitySnapshot({ interestingOnly }),
    getBoundingRect: ({ paneId, selector, frameId }) =>
      requireElement(paneId).getBoundingRect(selector, { frameId }),
    listFrames: ({ paneId }) => requireElement(paneId).listFrames(),
    setDownloadPolicy: ({ paneId, policy, downloadDir }) =>
      requireElement(paneId).setDownloadPolicy(policy, downloadDir),
    waitForDownload: ({ paneId, timeoutMs }) =>
      requireElement(paneId).waitForDownload({ timeoutMs }),
    acceptPopup: async ({ newSurfaceId, bounds }) => {
      // Element's `<bunite-webview adopt-popup-id=...>` attribute is the normal
      // path. RPC-invoked acceptPopup is for non-element callers; we route via
      // SurfaceCap with the renderer's hostViewId stamp.
      const surface = await getRuntimeSurface();
      const hostViewId = await getHostViewId();
      return surface.acceptPopup({ newSurfaceId, hostViewId, bounds });
    },
    dismissPopup: ({ paneId, newSurfaceId }) => requireElement(paneId).dismissPopup(newSurfaceId),
    extendPopupTimeout: ({ paneId, newSurfaceId, gracePeriodMs }) =>
      requireElement(paneId).extendAdoptionTimeout(newSurfaceId, gracePeriodMs),
    resolveAndClick: ({ paneId, selector, ...opts }) =>
      requireElement(paneId).resolveAndClick(selector, opts),

    // Stage F — streams (DOM event re-dispatched by element)
    surfaceEvents: ({ paneId }) =>
      Stream.from<BrowserPaneSurfaceEvent>((emit, signal) => {
        const el = requireElement(paneId);
        const handler = (e: Event) =>
          emit((e as CustomEvent<BrowserPaneSurfaceEvent>).detail);
        el.addEventListener("surface-event", handler);
        signal.addEventListener("abort", () =>
          el.removeEventListener("surface-event", handler)
        );
      }),
    downloadEvents: ({ paneId }) =>
      Stream.from<BrowserPaneDownloadEvent>((emit, signal) => {
        const el = requireElement(paneId);
        const handler = (e: Event) =>
          emit((e as CustomEvent<BrowserPaneDownloadEvent>).detail);
        el.addEventListener("download-event", handler);
        signal.addEventListener("abort", () =>
          el.removeEventListener("download-event", handler)
        );
      })
  };
}

let hostViewIdPromise: Promise<number> | null = null;
async function getHostViewId(): Promise<number> {
  if (!hostViewIdPromise) {
    hostViewIdPromise = (async () => {
      const conn = await getConnection();
      const runtime = conn.runtime();
      // bunite exposes hostViewId via runtime — fallback to 0 (acceptPopup may
      // require this; if API differs we revisit).
      return (runtime as unknown as { hostViewId?: number }).hostViewId ?? 0;
    })();
  }
  return hostViewIdPromise;
}
