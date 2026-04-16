import { randomBytes } from "node:crypto";

export interface FlmuxWebModeServerAuth {
  token: string;
  cookieName: string;
  queryParam: string;
}

export function resolveFlmuxWebModeServerAuth(env: NodeJS.ProcessEnv = process.env): FlmuxWebModeServerAuth {
  const configuredToken = env.FLMUX_WEB_TOKEN?.trim();

  return {
    token: configuredToken || randomBytes(24).toString("hex"),
    cookieName: "flmux_web_token",
    queryParam: "token"
  };
}
