import { resolve } from "node:path";

export interface FlmuxAuthPaths {
  authDir: string;
  usersFile: string;
  tokensFile: string;
  webauthnFile: string;
}

export function resolveFlmuxAuthPaths(authDir: string): FlmuxAuthPaths {
  return {
    authDir: resolve(authDir),
    usersFile: resolve(authDir, "users.toml"),
    tokensFile: resolve(authDir, "users.tokens.toml"),
    webauthnFile: resolve(authDir, "webauthn.toml")
  };
}
