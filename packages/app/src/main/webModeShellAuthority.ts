import {
  PaneRegistry,
  ShellCore,
  createPlaceholderPaneSpec,
  createShellModel,
  type PaneSpec,
  type ShellModelAPI
} from "@flmux/core/shell";
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
  start(origin: string): Promise<void>;
  applyTerminalEvent(event: TerminalRuntimeEvent): void;
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
    terminalBackend: options.terminalService
  });
  const shellModel = createShellModel({
    host: shellCore,
    terminal: shellCore.createTerminalDelegate()
  });
  const clientId = `server_${crypto.randomUUID()}`;

  return {
    clientId,
    shellModel,
    router: createServerShellModelRouter({
      authorityClientId: clientId,
      shellModel,
      getWorkspace: async () => shellCore.getWorkspaceStatus(),
      clientRegistry: options.clientRegistry
    }),
    async start(origin: string) {
      shellCore.setAppOrigin(origin);
      shellCore.initialize();
    },
    applyTerminalEvent(event) {
      shellCore.applyTerminalEvent(event);
    }
  };
}
