import type { DiscoveredLocalExtension } from "./localExtensions";
import { createWebModeShellAuthority, type WebModeShellAuthority } from "./webModeShellAuthority";
import type { FlmuxClientRegistry } from "./clientRegistry";
import type { TerminalService } from "./terminal-service";

export interface WebModeUserAuthorityRegistryOptions {
  projectDir: string;
  terminalService: TerminalService;
  clientRegistry: FlmuxClientRegistry;
  localExtensions?: readonly DiscoveredLocalExtension[];
  /** Server origin set at startup; forwarded to each user's authority on
   * first use so browser-pane URLs resolve against the live port. */
  getOrigin(): string;
  /** Called once per fresh authority right after it starts. Lets main.ts
   * attach per-authority index subscribers (e.g. paneId→authority for
   * terminal event routing) without the registry knowing about them. */
  onAuthorityCreated?(userId: string, authority: WebModeShellAuthority): void;
}

export interface WebModeUserAuthorityRegistry {
  getOrCreate(userId: string): Promise<WebModeShellAuthority>;
  get(userId: string): WebModeShellAuthority | undefined;
  list(): Array<{ userId: string; authority: WebModeShellAuthority }>;
}

/**
 * Lazy `Map<userId, WebModeShellAuthority>` factory. Each authenticated web
 * user gets their own `ShellCore` on first reach (via HTTP bootstrap, CLI
 * path call, or any other auth-gated entry point). Multiple browsers /
 * CLI sessions from the same user share that authority → their workspaces
 * and panes mirror each other.
 *
 * Phase 2 gaps (intentional):
 * - **Session persistence** — desktop keeps its single `sessionStore`;
 *   web has no per-user persistent store until we decide on the on-disk
 *   layout and admin migration story. A user's workspaces evaporate
 *   when the bun process exits.
 * - **Authority eviction** — authorities live for the process lifetime.
 *   Every user who ever authenticated contributes a `ShellCore` that
 *   receives every terminal event forever. Phase 2+ adds a
 *   no-attachment-in-grace-period sweep here.
 */
export function createWebModeUserAuthorityRegistry(
  options: WebModeUserAuthorityRegistryOptions
): WebModeUserAuthorityRegistry {
  const authorities = new Map<string, WebModeShellAuthority>();
  const pending = new Map<string, Promise<WebModeShellAuthority>>();

  async function create(userId: string): Promise<WebModeShellAuthority> {
    const authority = await createWebModeShellAuthority({
      projectDir: options.projectDir,
      runtimeLabel: `web server authority (${userId})`,
      terminalService: options.terminalService,
      clientRegistry: options.clientRegistry,
      localExtensions: options.localExtensions
    });
    await authority.start(options.getOrigin());
    authorities.set(userId, authority);
    options.onAuthorityCreated?.(userId, authority);
    return authority;
  }

  return {
    async getOrCreate(userId) {
      const existing = authorities.get(userId);
      if (existing) return existing;
      // Deduplicate concurrent bootstrap races: two requests for the same
      // fresh user must converge on a single authority.
      const inflight = pending.get(userId);
      if (inflight) return inflight;
      const promise = create(userId).finally(() => pending.delete(userId));
      pending.set(userId, promise);
      return promise;
    },
    get(userId) {
      return authorities.get(userId);
    },
    list() {
      return Array.from(authorities.entries()).map(([userId, authority]) => ({ userId, authority }));
    }
  };
}
