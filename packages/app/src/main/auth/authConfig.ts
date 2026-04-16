import { dirname, resolve } from "node:path";

export interface FlmuxAuthPaths {
  authDir: string;
  usersFile: string;
  tokensFile: string;
}

export function resolveDefaultAuthDir(): string {
  return dirname(Bun.main);
}

export function resolveFlmuxAuthDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FLMUX_AUTH_DIR?.trim();
  return override ? resolve(override) : resolveDefaultAuthDir();
}

export function resolveFlmuxAuthPaths(authDir: string): FlmuxAuthPaths {
  return {
    authDir: resolve(authDir),
    usersFile: resolve(authDir, "users.toml"),
    tokensFile: resolve(authDir, "users.tokens.toml")
  };
}
