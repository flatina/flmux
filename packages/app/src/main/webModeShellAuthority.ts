import {
  PaneRegistry,
  ShellCore,
  createPlaceholderPaneSpec,
  createShellModel,
  type PaneSpec,
  type SequencedShellCoreEvent,
  type ShellModelAPI
} from "@flmux/core/shell";
import type { FlmuxShellBootstrapResponse } from "../shared/rendererBridge";
import { buildBootstrapResponse } from "./desktopShellAuthority";
import type { TerminalRuntimeEvent } from "../shared/terminal";
import type { TerminalService } from "./terminal-service";
import { createServerShellModelRouter } from "./serverShellModelRouter";
import type { FlmuxClientRegistry } from "./clientRegistry";
import type { DiscoveredLocalExtension } from "./localExtensions";
import {
  createBuiltinPaneSpecs,
  createExtensionPaneSpecs,
  type ExtensionModuleImporter
} from "./paneSpecs";

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
  /** Build the snapshot for a browser attachment. No session restore —
   * web mode has no `sessionStore` in B1d (per-user persistence lands in
   * B2). `outerLayout`/`innerLayouts` are always `null` here. */
  shellBootstrap(attachmentId: string): FlmuxShellBootstrapResponse;
}

export async function createWebModeShellAuthority(options: {
  projectDir: string;
  runtimeLabel: string;
  terminalService: TerminalService;
  clientRegistry: FlmuxClientRegistry;
  localExtensions?: readonly DiscoveredLocalExtension[];
  extensionModuleImporter?: ExtensionModuleImporter;
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
    defaultSlotKey: "server"
  });
  const shellModel = createShellModel({
    host: shellCore,
    terminal: shellCore.createTerminalDelegate()
  });
  const clientId = `server_${crypto.randomUUID()}`;

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
    // (Preflight #1 §S3 + feedback Q4). Web authority has no session
    // restore, so outerLayout/innerLayouts are always empty.
    bootstrapAttachment(attachmentId);
    return buildBootstrapResponse({
      attachmentId,
      shellCore,
      outerLayout: null,
      innerLayouts: {}
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
      shellCore.initialize();
    },
    applyTerminalEvent(event) {
      shellCore.applyTerminalEvent(event);
    },
    bootstrapAttachment,
    shellBootstrap
  };
}
