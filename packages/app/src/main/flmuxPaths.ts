import { resolve, join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { isCompiledBinary } from "../shared/buildTarget";

interface FlmuxPaths {
  /** Install root — parent of `.flmux/`. All other paths derive from this. */
  rootDir: string;
  /** `<rootDir>/.flmux` — container for everything flmux writes to disk. */
  flmuxDir: string;
  /** `<flmuxDir>/tmp` — truly ephemeral, safe to delete at any time. */
  tmpDir: string;
  /** `<tmpDir>/ptyd.lock` — install-scoped ptyd daemon lock. */
  lockFile: string;
  /** `<flmuxDir>/bin` — install-scoped CLI shim directory. Prepended to
   * PATH in every terminal pane so `flmux <cmd>` resolves to the shim
   * written at app boot. */
  binDir: string;
  /** `<flmuxDir>/cef-userdata` — CEF's persistent user data (cookies,
   * localStorage, shader cache). Stable across runs so browser panes don't
   * lose their sessions on every relaunch. */
  cefUserDataDir: string;
  /** `<flmuxDir>/auth` — web-mode user credentials and per-user sessions. */
  authDir: string;
  usersFile: string;
  tokensFile: string;
  /** `<authDir>/webauthn.toml` — registered passkey credentials. */
  webauthnFile: string;
  webSessionsDir: string;
  /** `<flmuxDir>/session.json` — desktop single-user session snapshot. */
  desktopSessionFile: string;
  /** `<flmuxDir>/app.toml` — user-editable app config. Sections:
   * `[server] port`, `[app] name`/`appTitle`/`watermarkHeader`/`watermarkFooter`. */
  appConfigFile: string;
  /** `<flmuxDir>/ext` — parent of per-extension data dirs. Extensions are
   * handed only `<extDataRootDir>/<extensionId>/`; this parent isn't
   * advertised. Boundary is advisory (server entries have full fs access),
   * not syscall-enforced. */
  extDataRootDir: string;
  /** `<flmuxDir>/ext-shared` — extraction cache for archive-backed extensions'
   * `sharedDir` subtree (keyed `<id>/<version>`). Source extensions bind their
   * dist dir in place; this only materializes tarball assets. */
  extSharedDir: string;
  /** `<rootDir>/.flmux_users` — **sibling** of `.flmux` so the auth-secret
   * tree stays outside any user bind. Root of per-user/shared fs dirs. */
  usersRootDir: string;
}

export interface FlmuxInstallLayout {
  /** Compiled binary, or no real `Bun.main` → deploy layout (baseDir = exe dir). */
  isDeployLayout: boolean;
  /** Deploy: `process.execPath` dir. Dev: dir of the entry `Bun.main`. */
  baseDir: string;
  /** Parent of `.flmux`. Deploy: `baseDir`. Dev: repo root (`baseDir/../../..`). */
  installRoot: string;
}

/**
 * Mirrors bunite `getBaseDir`: a compiled binary's `Bun.main` is a `$bunfs`/`~BUN`
 * virtual path, so `dirname(Bun.main)` is bogus (climbs to `/`). Derive from
 * `process.execPath` instead. Single source for both `main.ts` and the CLI so
 * they can't drift (the CLI once resolved rootDir to `/` → `mkdir '/.flmux'`).
 */
export function resolveInstallLayout(): FlmuxInstallLayout {
  const isDeployLayout = isCompiledBinary || !(Bun.main && existsSync(Bun.main));
  const baseDir = isDeployLayout ? dirname(process.execPath) : dirname(Bun.main!);
  const installRoot = isDeployLayout ? baseDir : resolve(baseDir, "../../..");
  return { isDeployLayout, baseDir, installRoot };
}

export function resolveFlmuxRootDir(installRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FLMUX_ROOT_DIR?.trim();
  return override ? resolve(override) : resolve(installRoot);
}

export function resolveFlmuxPaths(rootDir: string): FlmuxPaths {
  const flmuxDir = join(rootDir, ".flmux");
  const tmpDir = join(flmuxDir, "tmp");
  const authDir = join(flmuxDir, "auth");
  return {
    rootDir: resolve(rootDir),
    flmuxDir,
    tmpDir,
    lockFile: join(tmpDir, "ptyd.lock"),
    binDir: join(flmuxDir, "bin"),
    cefUserDataDir: join(flmuxDir, "cef-userdata"),
    authDir,
    usersFile: join(authDir, "users.toml"),
    tokensFile: join(authDir, "users.tokens.toml"),
    webauthnFile: join(authDir, "webauthn.toml"),
    webSessionsDir: join(authDir, "sessions"),
    desktopSessionFile: join(flmuxDir, "session.json"),
    appConfigFile: join(flmuxDir, "app.toml"),
    extDataRootDir: join(flmuxDir, "ext"),
    extSharedDir: join(flmuxDir, "ext-shared"),
    usersRootDir: join(rootDir, ".flmux_users")
  };
}
