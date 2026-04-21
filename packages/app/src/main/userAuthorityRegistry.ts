import { join } from "node:path";
import type { DiscoveredLocalExtension } from "./localExtensions";
import { createSessionStore } from "./sessionStore";
import { createWebModeShellAuthority, type WebModeShellAuthority } from "./webModeShellAuthority";
import type { FlmuxClientRegistry } from "./clientRegistry";
import type { TerminalService } from "./terminal-service";

interface WebModeUserAuthorityRegistryOptions {
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
  /** Called when `evict(userId)` removes an authority. Mirror of
   * `onAuthorityCreated` — lets main.ts tear down the index subscribers
   * and clean up its per-authority state (paneId→authority entries,
   * pending debounce timers, etc.). */
  onAuthorityEvicted?(userId: string, authority: WebModeShellAuthority): void;
  /** When set, each user authority gets a persistent session store at
   * `<sessionsDir>/<userId>/session.json`. Workspaces survive process
   * restarts per-user. Omit to keep authorities in-memory only (tests,
   * dev without auth). */
  sessionsDir?: string;
}

export interface WebModeUserAuthorityRegistry {
  getOrCreate(userId: string): Promise<WebModeShellAuthority>;
  get(userId: string): WebModeShellAuthority | undefined;
  list(): Array<{ userId: string; authority: WebModeShellAuthority }>;
  /** Remove an authority from the registry. Main.ts calls this after the
   * no-attachment grace expires; the authority's `ShellCore` subscribers
   * are torn down via the `onAuthorityEvicted` callback. Returns the
   * evicted authority (or undefined if it wasn't registered). */
  evict(userId: string): WebModeShellAuthority | undefined;
}

/**
 * Lazy `Map<userId, WebModeShellAuthority>` factory. Each authenticated web
 * user gets their own `ShellCore` on first reach (via HTTP bootstrap, CLI
 * path call, or any other auth-gated entry point). Multiple browsers /
 * CLI sessions from the same user share that authority → their workspaces
 * and panes mirror each other.
 *
 * Per-user session persistence is wired when `sessionsDir` is set:
 * each authority gets its own store at `<sessionsDir>/<userId>/session.json`.
 * Without `sessionsDir` the authorities stay in-memory (useful for tests).
 *
 * Phase 2+ gap (intentional):
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
    const sessionStore = options.sessionsDir
      ? createSessionStore({ filePath: join(options.sessionsDir, userId, "session.json") })
      : undefined;
    const authority = await createWebModeShellAuthority({
      projectDir: options.projectDir,
      runtimeLabel: `web server authority (${userId})`,
      terminalService: options.terminalService,
      clientRegistry: options.clientRegistry,
      localExtensions: options.localExtensions,
      sessionStore
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
    },
    evict(userId) {
      const authority = authorities.get(userId);
      if (!authority) return undefined;
      authorities.delete(userId);
      options.onAuthorityEvicted?.(userId, authority);
      return authority;
    }
  };
}
