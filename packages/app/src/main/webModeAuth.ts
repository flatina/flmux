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
   * userId via `clientIdToUserId`, not a token. */
  getUser(name: string): FlmuxUser | null;
  /** Same as `getUser`, plus honors the `--dev-auth-as` synthetic-user
   * fallback — returns the permissive dev user when its name matches and
   * the TOML entry is absent. Used by non-HTTP call sites (extension
   * server `ctx.shell`) that don't have a token to call `authorize`. */
  resolveUserByName(name: string): FlmuxUser | null;
  isPaneKindAllowed(user: FlmuxUser, kind: string): boolean;
  /** True when the user's `allow_paths.{method}` permits `path`. Absent
   * config (or value `"*"`) permits every path. Missing method key
   * denies all paths for that method. */
  isPathAllowed(user: FlmuxUser, method: PathAccessMethod, path: string): boolean;
}

export function createFlmuxWebModeAuthorizer(
  paths: FlmuxAuthPaths,
  options: { devAuthAs?: string } = {}
): FlmuxWebModeAuthorizer {
  const userStore = createUserStore(paths.usersFile);
  const tokenStore = createTokenStore(paths.tokensFile);

  return createAuthorizerFromStores({ userStore, tokenStore, devAuthAs: options.devAuthAs });
}

function createAuthorizerFromStores(options: {
  userStore: UserStore;
  tokenStore: TokenStore;
  /** Dev-only bypass: when set, every call to `authorize` returns the named
   * user regardless of token. Resolves against `userStore` first so an
   * existing TOML user's ACL still applies; missing entry → synthesize
   * `allowPaneKinds = "*"`, `allowPaths = "*"`. Must be gated at the call
   * site — the authorizer itself doesn't know it's running in dev mode. */
  devAuthAs?: string;
}): FlmuxWebModeAuthorizer {
  const devAuthAsName = options.devAuthAs?.trim() || undefined;

  return {
    cookieName: "flmux_web_token",
    queryParam: "token",
    authorize(tokenValue) {
      if (devAuthAsName) {
        // Resolve on every request so edits to users.toml take effect
        // without a restart — mirrors the regular token path.
        return resolveDevContext(options.userStore, devAuthAsName);
      }
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
    resolveUserByName(name) {
      const existing = options.userStore.getUser(name);
      if (existing) return existing;
      if (devAuthAsName && name === devAuthAsName) {
        return resolveDevContext(options.userStore, devAuthAsName).user;
      }
      return null;
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

function resolveDevContext(userStore: UserStore, name: string): FlmuxAuthorizationContext {
  const existing = userStore.getUser(name);
  const user: FlmuxUser = existing ?? {
    name,
    allowPaneKinds: "*",
    allowPaths: "*"
  };
  return { user, tokenId: "dev-auth-as" };
}
