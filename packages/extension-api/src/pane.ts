import type { WorkspaceBusClient } from "./bus";
import type { ShellClient } from "./shell";
import type { PaneStateStore } from "./state";
import type { WorkspaceStatusStoreClient } from "./status";

// Re-exported from `./placement` so the same type is reachable from
// `@flmux/extension-api/cli` without dragging this file's DOM-typed
// renderer surface into CLI typechecks.
import type { PanePlacement } from "./placement";
export type { PanePlacement };
export type PaneKind = "browser" | "terminal" | (string & {});

export interface NewPaneInput {
  kind: PaneKind;
  title?: string;
  url?: string;
  cwd?: string;
  params?: Record<string, unknown>;
  place?: PanePlacement;
  referencePaneId?: string;
}

export interface PaneHeaderMenuItem {
  id: string;
  label: string;
  /** data: URL, http(s) URL, or short text/emoji. Resolved via `<img>` for
   *  URL-shaped values, otherwise rendered as plain text. */
  icon?: string;
  disabled?: boolean;
  onClick(): void;
}

/** Either a flat list (rendered as a popup menu) or a `build` callback
 *  that owns the popup contents. flmux opens an empty popup container,
 *  calls `build`, and disposes the returned cleanup on close. */
export type PaneHeaderMenu =
  | { items: PaneHeaderMenuItem[] }
  | { build(container: HTMLElement, api: { close(): void }): (() => void) | void };

export interface CapturePaneOptions {
  /** Target width on the page in mm — drives layout size (label density +
   *  on-page font size). Required: print/report layout is caller knowledge,
   *  not a flmux default. */
  widthMm: number;
  /** Target height in mm. Omit to derive from the target host's aspect ratio. */
  heightMm?: number;
  /** Output resolution; pixelRatio = dpi/96. Default 300 (print). */
  dpi?: number;
  /** Fill behind transparent areas. Default "white". A pane painting an opaque
   *  themed surface must switch to white in `onBeforeCapture` — this only fills gaps. */
  background?: string;
  /** Hard cap per output side (browser canvas limit). Default ~8192. */
  maxOutputPx?: number;
}

export interface CapturedImage {
  blob: Blob;
  width: number;
  height: number;
}

export interface ExtensionPaneContext {
  paneId: string;
  workspaceId: string;
  /** Logged-in user; `_root` on desktop. Key per-user state/storage by this. */
  userId: string;
  shell: ShellClient;
  bus: WorkspaceBusClient;
  /** Retained KV store shared with every pane in the same workspace.
   *  Non-persistent. `subscribe` replays the current value immediately so
   *  late mounts don't miss it. */
  workspaceStatus: WorkspaceStatusStoreClient;
  state: PaneStateStore;
  /** Set/clear the pane's tab-header menu. Pass `null` to remove. */
  setHeaderMenu(menu: PaneHeaderMenu | null): void;
  /** Capture another pane in the SAME workspace as a high-resolution PNG.
   *  flmux resizes the target host to the requested physical size (so its
   *  `ResizeObserver` re-fits for more detail), awaits the target's
   *  `onBeforeCapture`, rasterizes the host (DOM + 2D canvases) via dom-to-image,
   *  then restores. Exclusive — await each call; a concurrent call rejects.
   *  Rejects if the target isn't a capturable extension pane in this workspace
   *  (browser/iframe panes are not capturable). */
  capturePane(targetPaneId: string, opts: CapturePaneOptions): Promise<CapturedImage>;
}

export interface ExtensionPaneInstance {
  update?(params: Record<string, unknown>): void;
  layout?(width: number, height: number): void;
  focus?(): void;
  toJSON?(): Record<string, unknown>;
  dispose?(): void;
  /** Capture prep. flmux has already resized this pane's host to `width`×`height`
   *  (output px) before calling. Set your supersample (e.g. SciChart
   *  `DpiHelper.PIXEL_RATIO = dpr`), switch to a print/white surface, force a
   *  re-fit, and resolve ONLY once the surface is settled — only the pane knows
   *  when its render is done. */
  onBeforeCapture?(opts: { width: number; height: number; dpr: number }): void | Promise<void>;
  /** Restore what `onBeforeCapture` changed. Must be idempotent/defensive —
   *  may run after a partial or throwing `onBeforeCapture`. */
  onAfterCapture?(): void | Promise<void>;
}

// ── pathMount / lifecycle (host-side) ──

export interface ExtensionPanePathMountSnapshotArgs {
  paneId: string;
  workspaceId: string;
  defaultBrowserPath: string;
  currentParams: Record<string, unknown> | undefined;
}

export interface ExtensionPanePathMountSetArgs extends ExtensionPanePathMountSnapshotArgs {
  relativePath: string[];
  value: unknown;
  setParams(nextParams: Record<string, unknown>): Promise<Record<string, unknown>>;
  patchParams(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface ExtensionPanePathMountWritableArgs extends ExtensionPanePathMountSnapshotArgs {
  relativePath: string[];
}

export interface ExtensionPanePathMountCallableArgs extends ExtensionPanePathMountSnapshotArgs {
  relativePath: string[];
  args: Record<string, unknown>;
  setParams(nextParams: Record<string, unknown>): Promise<Record<string, unknown>>;
  patchParams(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface ExtensionPanePathMount {
  mountKey: string;
  getStateSnapshot?(args: ExtensionPanePathMountSnapshotArgs): Record<string, unknown> | undefined;
  canSetStatePath?(args: ExtensionPanePathMountWritableArgs): boolean;
  setState?(args: ExtensionPanePathMountSetArgs): Promise<{ value: unknown }> | { value: unknown };
  // RPC-style action: computed return, snapshot leaf is not required. Gated
  // by `allow_paths.call` on the shared ShellModelAPI ACL.
  canCallStatePath?(args: ExtensionPanePathMountWritableArgs): boolean;
  callState?(args: ExtensionPanePathMountCallableArgs): Promise<{ value: unknown }> | { value: unknown };
  getStatusSnapshot?(args: ExtensionPanePathMountSnapshotArgs): Record<string, unknown> | undefined;
}

/** Host-side pane spec. Lives on the server entry — runs in the flmux main
 *  process, never in the renderer. Provides everything flmux needs to route
 *  ShellModelAPI calls and create/restore panes without ever evaluating
 *  renderer code. */
export interface ExtensionPaneSpec {
  kind: string;
  createParams?(args: {
    workspaceId: string;
    defaultBrowserPath: string;
    input: NewPaneInput;
  }): Record<string, unknown> | undefined;
  getTitle?(args: {
    workspaceId: string;
    defaultBrowserPath: string;
    input: NewPaneInput;
    params: Record<string, unknown> | undefined;
  }): string;
  normalizeRestoredParams?(args: {
    workspaceId: string;
    defaultBrowserPath: string;
    params: Record<string, unknown> | undefined;
  }): Record<string, unknown> | undefined;
  serializeParams?(args: {
    workspaceId: string;
    defaultBrowserPath: string;
    currentParams: Record<string, unknown> | undefined;
  }): Record<string, unknown> | undefined;
  pathMount?: ExtensionPanePathMount;
}

/** Renderer-side pane renderer. Lives on the renderer entry — runs in the
 *  browser only, never on the host. Pure DOM mount; lifecycle and pathMount
 *  belong on `ExtensionPaneSpec` (server entry). */
export interface ExtensionPaneRenderer {
  kind: string;
  mount(host: HTMLElement, context: ExtensionPaneContext): void | ExtensionPaneInstance;
}

export function definePaneSpec<T extends ExtensionPaneSpec>(spec: T): T {
  return spec;
}

export function definePaneRenderer<T extends ExtensionPaneRenderer>(renderer: T): T {
  return renderer;
}
