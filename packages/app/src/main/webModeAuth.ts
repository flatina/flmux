import type { FlmuxAuthPaths } from "./auth/authConfig";
import { hashToken } from "./auth/tokenFormat";
import { createTokenStore, type TokenStore } from "./auth/tokenStore";
import { createUserStore, type FlmuxUser, type UserStore } from "./auth/userStore";

export interface FlmuxAuthorizationContext {
  user: FlmuxUser;
  tokenId: string;
}

export interface FlmuxWebModeAuthorizer {
  readonly cookieName: string;
  readonly queryParam: string;
  authorize(tokenValue: string): FlmuxAuthorizationContext | null;
  isPaneKindAllowed(user: FlmuxUser, kind: string): boolean;
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
    isPaneKindAllowed(user, kind) {
      if (user.allowPaneKinds === "*") {
        return true;
      }
      return user.allowPaneKinds.includes(kind);
    }
  };
}
