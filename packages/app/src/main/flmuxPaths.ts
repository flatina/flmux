import { resolve, join } from "node:path";

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
  webSessionsDir: string;
  /** `<flmuxDir>/session.json` — desktop single-user session snapshot. */
  desktopSessionFile: string;
  /** `<flmuxDir>/server.toml` — user-editable server config (port etc.). */
  serverConfigFile: string;
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
    webSessionsDir: join(authDir, "sessions"),
    desktopSessionFile: join(flmuxDir, "session.json"),
    serverConfigFile: join(flmuxDir, "server.toml")
  };
}
