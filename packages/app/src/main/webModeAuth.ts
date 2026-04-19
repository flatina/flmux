import type { FlmuxAuthPaths } from "./auth/authConfig";
import { matchAnyPathGlob } from "./auth/pathGlob";
import { hashToken } from "./auth/tokenFormat";
import { createTokenStore, type TokenStore } from "./auth/tokenStore";
import { createUserStore, type FlmuxUser, type UserStore } from "./auth/userStore";

export interface FlmuxAuthorizationContext {
  user: FlmuxUser;
  tokenId: string;
}

/** `/api/model/path/*` methods gated by `allow_paths`. `list` is treated
 * as a read (directory-like enumeration of the same path). */
export type PathAccessMethod = "read" | "write" | "call";

export interface FlmuxWebModeAuthorizer {
  readonly cookieName: string;
  readonly queryParam: string;
  authorize(tokenValue: string): FlmuxAuthorizationContext | null;
  /** Look up a user by name. Used by the WS event forwarder to check
   * `allow_paths.read` against shellCore events — we only have the
   * userId via `attachmentIdToUserId`, not a token. */
  getUser(name: string): FlmuxUser | null;
  isPaneKindAllowed(user: FlmuxUser, kind: string): boolean;
  /** True when the user's `allow_paths.{method}` permits `path`. Absent
   * config (or value `"*"`) permits every path. Missing method key
   * denies all paths for that method. */
  isPathAllowed(user: FlmuxUser, method: PathAccessMethod, path: string): boolean;
}

export function createFlmuxWebModeAuthorizer(paths: FlmuxAuthPaths): FlmuxWebModeAuthorizer {
  const userStore = createUserStore(paths.usersFile);
  const tokenStore = createTokenStore(paths.tokensFile);

  return createAuthorizerFromStores({ userStore, tokenStore });
}

export function createAuthorizerFromStores(options: {
  userStore: UserStore;
  tokenStore: TokenStore;
}): FlmuxWebModeAuthorizer {
  return {
    cookieName: "flmux_web_token",
    queryParam: "token",
    authorize(tokenValue) {
      if (!tokenValue) {
        return null;
      }

      const tokenRecord = options.tokenStore.findByHash(hashToken(tokenValue));
      if (!tokenRecord) {
        return null;
      }

      if (tokenRecord.expiresAt) {
        const expiryMs = Date.parse(tokenRecord.expiresAt);
        if (Number.isNaN(expiryMs) || expiryMs <= Date.now()) {
          return null;
        }
      }

      const user = options.userStore.getUser(tokenRecord.user);
      if (!user) {
        return null;
      }

      return { user, tokenId: tokenRecord.id };
    },
    getUser(name) {
      return options.userStore.getUser(name);
    },
    isPaneKindAllowed(user, kind) {
      if (user.allowPaneKinds === "*") {
        return true;
      }
      return user.allowPaneKinds.includes(kind);
    },
    isPathAllowed(user, method, path) {
      if (user.allowPaths === "*") {
        return true;
      }
      const patterns = user.allowPaths[method];
      if (!patterns || patterns.length === 0) {
        return false;
      }
      return matchAnyPathGlob(patterns, path);
    }
  };
}
