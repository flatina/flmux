import {
  PLACEHOLDER_PANE_KIND,
  PaneRegistry,
  ShellCore,
  createPlaceholderPaneSpec,
  createShellModel,
  type PaneSpec,
  type SequencedShellCoreEvent,
  type ShellModelAPI
} from "@flmux/core/shell";
import type {
  FlmuxSessionSaveLayouts,
  FlmuxShellBootstrapResponse,
  FlmuxShellSnapshot
} from "../shared/rendererBridge";
import type { FlmuxSessionSnapshot, FlmuxWorkspaceSessionSnapshot } from "../shared/session";
import type { TerminalRuntimeEvent } from "@flmux/core/terminal/types";
import { createServerShellModelRouter } from "./serverShellModelRouter";
import type { FlmuxClientRegistry } from "./clientRegistry";
import type { DiscoveredLocalExtension } from "./localExtensions";
import { createBuiltinPaneSpecs, createExtensionPaneSpecs, type ExtensionModuleImporter } from "./paneSpecs";
import type { FlmuxSessionStore } from "./sessionStore";
import type { TerminalService } from "./terminal-service";

export interface DesktopShellAuthority {
  readonly clientId: string;
  readonly shellModel: ShellModelAPI;
  readonly shellCore: ShellCore;
  readonly router: ReturnType<typeof createServerShellModelRouter>;
  subscribe(handler: (event: SequencedShellCoreEvent) => void): () => void;
  start(origin: string): Promise<void>;
  applyTerminalEvent(event: TerminalRuntimeEvent): void;
  /** Seed the attachment's active workspace if the slot is fresh. Idempotent
   * by design: slots that already hold an active ws short-circuit, so tab
   * refresh within grace and desktop repeat-calls are both safe. */
  bootstrapAttachment(attachmentId: string): void;
  /** Build the bootstrap snapshot for `attachmentId`. Desktop callers pass
   * `DESKTOP_ATTACHMENT_ID` ("local") via the preload RPC; web browsers
   * pass the server-minted attachmentId via the HTTP bootstrap route. */
  shellBootstrap(attachmentId: string): FlmuxShellBootstrapResponse;
  persistSession(layouts: FlmuxSessionSaveLayouts): Promise<void>;
}

export const DESKTOP_ATTACHMENT_ID = "local";

export async function createDesktopShellAuthority(options: {
  projectDir: string;
  runtimeLabel: string;
  terminalService: TerminalService;
  sessionStore: FlmuxSessionStore;
  clientRegistry: FlmuxClientRegistry;
  localExtensions?: readonly DiscoveredLocalExtension[];
  extensionModuleImporter?: ExtensionModuleImporter;
}): Promise<DesktopShellAuthority> {
  const paneRegistry = new PaneRegistry<PaneSpec>();
  paneRegistry.register(createPlaceholderPaneSpec());
  for (const spec of createBuiltinPaneSpecs(options.projectDir)) {
    paneRegistry.register(spec);
  }
  for (const spec of await createExtensionPaneSpecs(options.localExtensions ?? [], options.extensionModuleImporter)) {
    paneRegistry.register(spec);
  }

  const shellCore = new ShellCore({
    paneRegistry,
    runtimeLabel: options.runtimeLabel,
    projectDir: options.projectDir,
    terminalBackend: options.terminalService,
    // Phase B: the CEF renderer is a single attachment; name its slot
    // `"local"` so scope=attachment event envelopes are self-describing.
    // B2 switches to per-attachment slotKey = real attachmentId.
    defaultSlotKey: DESKTOP_ATTACHMENT_ID
  });
  const shellModel = createShellModel({
    host: shellCore,
    terminal: shellCore.createTerminalDelegate()
  });
  const clientId = `desktop_${crypto.randomUUID()}`;

  let persistedOuterLayout: unknown | null = null;
  let persistedInnerLayouts: Record<string, unknown | null> = {};

  async function start(origin: string) {
    shellCore.setAppOrigin(origin);
    const snapshot = await options.sessionStore.load();
    const restored = snapshot ? restoreFromSession(shellCore, snapshot) : null;
    if (restored) {
      persistedOuterLayout = restored.outerLayout;
      persistedInnerLayouts = restored.innerLayouts;
      return;
    }
    shellCore.initialize();
  }

  function bootstrapAttachment(attachmentId: string) {
    if (shellCore.getSlotActiveWorkspaceId(attachmentId) !== null) {
      return;
    }
    const [firstWs] = shellCore.getWorkspaceIds();
    if (!firstWs) {
      throw new Error("bootstrapAttachment: shell has no workspaces to seed active");
    }
    shellCore.setActiveWorkspace(firstWs, { slotKey: attachmentId });
  }

  return {
    clientId,
    shellModel,
    shellCore,
    router: createServerShellModelRouter({
      authorityClientId: clientId,
      shellModel,
      getWorkspace: async () => shellCore.getWorkspaceStatus(),
      clientRegistry: options.clientRegistry
    }),
    subscribe: (handler) => shellCore.subscribe(handler),
    start,
    applyTerminalEvent: (event) => shellCore.applyTerminalEvent(event),
    bootstrapAttachment,
    shellBootstrap: (attachmentId: string) => {
      // Preflight #1 §S3 + feedback Q4: mutate (bootstrap helper) THEN
      // capture seqStart inside buildBootstrapResponse so any
      // `workspace.activeChanged` emitted here has seq ≤ seqStart and is
      // filtered by the client's seq gate (no double-apply).
      bootstrapAttachment(attachmentId);
      return buildBootstrapResponse({
        attachmentId,
        shellCore,
        outerLayout: persistedOuterLayout,
        innerLayouts: persistedInnerLayouts
      });
    },
    persistSession: async (layouts) => {
      const composed = composeSessionSnapshot(shellCore, layouts);
      await options.sessionStore.save(composed);
    }
  };
}

export function restoreFromSession(
  shellCore: ShellCore,
  snapshot: FlmuxSessionSnapshot
): FlmuxSessionSaveLayouts | null {
  if (!snapshot.outerLayout) {
    return null;
  }
  const outerPanelIds = extractOuterPanelIds(snapshot.outerLayout);
  if (outerPanelIds.size === 0) {
    return null;
  }

  // Defer mutations (setAppTitle + restoreWorkspace) until we know the
  // snapshot yields at least one workspace — a malformed/empty payload
  // must not leak partial state into the seeded default path.
  const restorablePairs: Array<[string, FlmuxWorkspaceSessionSnapshot]> = [];
  for (const [workspaceId, workspaceSnapshot] of Object.entries(snapshot.workspaces)) {
    if (outerPanelIds.has(workspaceId)) {
      restorablePairs.push([workspaceId, workspaceSnapshot]);
    }
  }
  if (restorablePairs.length === 0) {
    return null;
  }

  if (snapshot.appTitle) {
    shellCore.setAppTitle(snapshot.appTitle);
  }
  const innerLayouts: Record<string, unknown | null> = {};
  for (const [workspaceId, workspaceSnapshot] of restorablePairs) {
    const defaultTitle = workspaceSnapshot.defaultTitle?.trim() || defaultWorkspaceTitle(workspaceId);
    const title = workspaceSnapshot.title.trim() || defaultTitle;
    shellCore.restoreWorkspace({ id: workspaceId, title, defaultTitle });
    innerLayouts[workspaceId] = workspaceSnapshot.innerLayout
      ? rebuildPaneRecordsFromLayout(shellCore, workspaceId, workspaceSnapshot.innerLayout)
      : null;
  }
  return { outerLayout: snapshot.outerLayout, innerLayouts };
}

function rebuildPaneRecordsFromLayout(shellCore: ShellCore, workspaceId: string, layout: unknown): unknown {
  if (!isPlainObject(layout)) {
    return layout;
  }
  const cloned = cloneJson(layout);
  const panels = isPlainObject(cloned.panels) ? cloned.panels : null;
  if (!panels) {
    return cloned;
  }
  for (const [paneId, raw] of Object.entries(panels)) {
    if (!isPlainObject(raw)) {
      continue;
    }
    const kind = typeof raw.contentComponent === "string" ? raw.contentComponent : "";
    if (!kind) {
      throw new Error(`Persisted panel '${paneId}' missing contentComponent`);
    }
    const params = isPlainObject(raw.params) ? cloneJson(raw.params) : undefined;
    const title = typeof raw.title === "string" ? raw.title : undefined;
    const restored = shellCore.restorePane(workspaceId, { paneId, kind, params, title });
    const normalizedParams = shellCore.peekPaneParams(paneId);
    if (restored.kind !== kind) {
      raw.contentComponent = PLACEHOLDER_PANE_KIND;
      raw.title = restored.title;
      raw.params = normalizedParams ?? { originalKind: kind };
    } else if (normalizedParams !== undefined) {
      raw.params = normalizedParams;
    }
  }
  return cloned;
}

export function buildBootstrapResponse(options: {
  attachmentId: string;
  shellCore: ShellCore;
  outerLayout: unknown | null;
  innerLayouts: Record<string, unknown | null>;
}): FlmuxShellBootstrapResponse {
  const { shellCore } = options;
  // Preflight #1 §S3: capture seqStart BEFORE composing the snapshot so the
  // invariant "every event with seq <= seqStart is already folded into the
  // snapshot" is load-bearing under future edits. Body remains fully sync.
  const seqStart = shellCore.currentSeq;
  const workspaceIds = shellCore.getWorkspaceIds();
  const panes: Record<string, ReturnType<ShellCore["listPanesByWorkspace"]>> = {};
  const paneParams: Record<string, Record<string, unknown> | undefined> = {};
  for (const workspaceId of workspaceIds) {
    const workspacePanes = shellCore.listPanesByWorkspace(workspaceId);
    panes[workspaceId] = workspacePanes;
    for (const pane of workspacePanes) {
      paneParams[pane.id] = shellCore.peekPaneParams(pane.id);
    }
  }
  const app = shellCore.getAppSnapshot();
  const snapshot: FlmuxShellSnapshot = {
    app,
    workspaces: workspaceIds.map((id) => shellCore.getWorkspaceSnapshot(id)!),
    panes,
    paneParams,
    // Read the attachment's slot explicitly — coupling to defaultSlotKey
    // should be visible here.
    activeWorkspaceId: shellCore.getSlotActiveWorkspaceId(options.attachmentId)
  };
  return {
    attachmentId: options.attachmentId,
    snapshot,
    outerLayout: options.outerLayout,
    innerLayouts: options.innerLayouts,
    seqStart
  };
}

export function composeSessionSnapshot(shellCore: ShellCore, layouts: FlmuxSessionSaveLayouts): FlmuxSessionSnapshot {
  const outerPanelIds = extractOuterPanelIds(layouts.outerLayout);
  const workspaces: Record<string, FlmuxWorkspaceSessionSnapshot> = {};
  for (const workspaceId of shellCore.getWorkspaceIds()) {
    if (!outerPanelIds.has(workspaceId)) {
      continue;
    }
    const status = shellCore.getWorkspaceSnapshot(workspaceId)!;
    const innerLayout = layouts.innerLayouts[workspaceId] ?? null;
    workspaces[workspaceId] = {
      title: status.title,
      defaultTitle: status.defaultTitle,
      innerLayout: innerLayout ? overlaySerializedParams(shellCore, workspaceId, innerLayout) : null
    };
  }
  return {
    version: 4,
    appTitle: shellCore.getAppTitle(),
    outerLayout: layouts.outerLayout,
    workspaces
  };
}

function overlaySerializedParams(shellCore: ShellCore, workspaceId: string, layout: unknown): unknown {
  if (!isPlainObject(layout)) {
    return layout;
  }
  const cloned = cloneJson(layout);
  const panels = isPlainObject(cloned.panels) ? cloned.panels : null;
  if (!panels) {
    return cloned;
  }
  const validPaneIds = new Set<string>();
  for (const paneId of Object.keys(panels)) {
    if (shellCore.getPaneWorkspaceId(paneId) !== workspaceId) {
      // Drop panels whose id is no longer in core: a pane closed between
      // renderer layout capture and main compose. Leaving stale entries
      // would resurrect the pane on next restore.
      delete panels[paneId];
      continue;
    }
    validPaneIds.add(paneId);
    const raw = panels[paneId];
    if (!isPlainObject(raw)) {
      continue;
    }
    const serialized = shellCore.serializePaneParams(paneId);
    if (serialized !== undefined) {
      raw.params = serialized;
    }
  }
  const grid = isPlainObject(cloned.grid) ? cloned.grid : null;
  if (grid && isPlainObject(grid.root)) {
    pruneGridPaneRefs(grid.root, validPaneIds);
  }
  return cloned;
}

function pruneGridPaneRefs(node: Record<string, unknown>, validPaneIds: Set<string>): void {
  if (node.type === "leaf" && isPlainObject(node.data)) {
    const data = node.data;
    if (Array.isArray(data.views)) {
      data.views = data.views.filter((view): view is string => typeof view === "string" && validPaneIds.has(view));
    }
    if (typeof data.activeView === "string" && !validPaneIds.has(data.activeView)) {
      delete data.activeView;
    }
    return;
  }
  if (node.type === "branch" && Array.isArray(node.data)) {
    for (const child of node.data) {
      if (isPlainObject(child)) {
        pruneGridPaneRefs(child, validPaneIds);
      }
    }
  }
}

function extractOuterPanelIds(outerLayout: unknown): Set<string> {
  const ids = new Set<string>();
  if (!isPlainObject(outerLayout)) {
    return ids;
  }
  const panels = outerLayout.panels;
  if (isPlainObject(panels)) {
    for (const id of Object.keys(panels)) {
      ids.add(id);
    }
  }
  return ids;
}

function defaultWorkspaceTitle(workspaceId: string): string {
  const numbered = /^workspace\.(\d+)$/.exec(workspaceId);
  if (numbered) {
    return `Workspace ${numbered[1]}`;
  }
  return (
    workspaceId
      .split(/[./_-]/g)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || "Workspace"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
