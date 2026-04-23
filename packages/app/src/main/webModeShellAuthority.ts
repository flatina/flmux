import {
  PaneRegistry,
  ShellCore,
  createPlaceholderPaneSpec,
  createShellModel,
  type PaneSpec,
  type SequencedShellCoreEvent,
  type ShellModelAPI
} from "@flmux/core/shell";
import type { FlmuxSessionSaveLayouts, FlmuxShellBootstrapResponse } from "../shared/rendererBridge";
import { buildBootstrapResponse, composeSessionSnapshot, restoreFromSession } from "./desktopShellAuthority";
import type { TerminalRuntimeEvent } from "@flmux/core/terminal/types";
import type { TerminalService } from "./terminal-service";
import { createServerShellModelRouter } from "./serverShellModelRouter";
import type { FlmuxClientRegistry } from "./clientRegistry";
import type { DiscoveredLocalExtension } from "./localExtensions";
import { createBuiltinPaneSpecs, createExtensionPaneSpecs, type ExtensionModuleImporter } from "./paneSpecs";
import type { FlmuxSessionStore } from "./sessionStore";

export interface WebModeShellAuthority {
  readonly clientId: string;
  readonly shellModel: ShellModelAPI;
  readonly router: ReturnType<typeof createServerShellModelRouter>;
  subscribe(handler: (event: SequencedShellCoreEvent) => void): () => void;
  start(origin: string): Promise<void>;
  applyTerminalEvent(event: TerminalRuntimeEvent): void;
  /** Mirror of the desktop helper — seeds the attachment's active ws when
   * the slot is fresh. Idempotent. */
  bootstrapAttachment(attachmentId: string): void;
  /** Build the snapshot for a browser attachment. Includes `outerLayout` /
   * `innerLayouts` when a session store is wired and the last save was
   * restored at startup; empty otherwise. */
  shellBootstrap(attachmentId: string): FlmuxShellBootstrapResponse;
  /** Persist the caller's layout delta to this authority's session store.
   * `undefined` when no store is wired (single-user dev mode / tests) —
   * callers should tolerate absence the same way desktop does. */
  persistSession?(layouts: FlmuxSessionSaveLayouts): Promise<void>;
}

export async function createWebModeShellAuthority(options: {
  projectDir: string;
  runtimeLabel: string;
  terminalService: TerminalService;
  clientRegistry: FlmuxClientRegistry;
  localExtensions?: readonly DiscoveredLocalExtension[];
  extensionModuleImporter?: ExtensionModuleImporter;
  /** Per-user persistent store. When present, `start()` attempts
   * `sessionStore.load()` + `restoreFromSession` before falling back to
   * `initialize()`; `persistSession` writes through to the store. */
  sessionStore?: FlmuxSessionStore;
  /** Authenticated user this authority serves. Surfaced through
   * `/status/attachments/{id}/userId` so extensions can key session state
   * per user. `undefined` (legacy single-tenant tests) maps to `"local"`. */
  userId?: string;
}): Promise<WebModeShellAuthority> {
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
    // Web-mode authority's default slot is the server-side ShellModelAPI
    // driver (CLI, external HTTP calls without a browser attachment). B2
    // replaces this with per-attachment (browser) slots.
    defaultSlotKey: "server",
    authorityUserId: options.userId
  });
  const shellModel = createShellModel({
    host: shellCore,
    terminal: shellCore.createTerminalDelegate()
  });
  const clientId = `server_${crypto.randomUUID()}`;

  // Persisted snapshot layouts survive across restarts if a session store
  // is wired. Populated at start() via load+restore; consumed by
  // shellBootstrap so the first attachment sees the restored workspace
  // tree instead of the seed.
  let persistedOuterLayout: unknown | null = null;
  let persistedInnerLayouts: Record<string, unknown | null> = {};

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

  function shellBootstrap(attachmentId: string): FlmuxShellBootstrapResponse {
    // Mirror of the desktop path: mutate (bootstrap helper) BEFORE capturing
    // seqStart (inside buildBootstrapResponse) so the emitted
    // `workspace.activeChanged` is already folded into the snapshot boundary
    // (Preflight #1 §S3 + feedback Q4).
    bootstrapAttachment(attachmentId);
    return buildBootstrapResponse({
      attachmentId,
      shellCore,
      outerLayout: persistedOuterLayout,
      innerLayouts: persistedInnerLayouts
    });
  }

  return {
    clientId,
    shellModel,
    router: createServerShellModelRouter({
      authorityClientId: clientId,
      shellModel,
      getWorkspace: async () => shellCore.getWorkspaceStatus(),
      clientRegistry: options.clientRegistry
    }),
    subscribe: (handler) => shellCore.subscribe(handler),
    async start(origin: string) {
      shellCore.setAppOrigin(origin);
      const snapshot = options.sessionStore ? await options.sessionStore.load() : null;
      const restored = snapshot ? restoreFromSession(shellCore, snapshot) : null;
      if (restored) {
        persistedOuterLayout = restored.outerLayout;
        persistedInnerLayouts = restored.innerLayouts;
        return;
      }
      shellCore.initialize();
    },
    applyTerminalEvent(event) {
      shellCore.applyTerminalEvent(event);
    },
    bootstrapAttachment,
    shellBootstrap,
    persistSession: options.sessionStore
      ? async (layouts: FlmuxSessionSaveLayouts) => {
          const composed = composeSessionSnapshot(shellCore, layouts);
          await options.sessionStore!.save(composed);
        }
      : undefined
  };
}
