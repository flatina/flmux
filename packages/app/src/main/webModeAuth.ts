import type { FlmuxAuthPaths } from "./auth/authConfig";
import { matchAnyPathGlob } from "./auth/pathGlob";
import { hashToken } from "./auth/tokenFormat";
import { createTokenStore, type FlmuxIssuedToken, type TokenStore } from "./auth/tokenStore";
import { createUserStore, type FlmuxUser, type UserStore } from "./auth/userStore";

export interface FlmuxAuthorizationContext {
  user: FlmuxUser;
  tokenId: string;
}

/** Result of validating an enrollment token. Never overlaps with a session:
 * resolved against the enrollment namespace only, returns the bound user name
 * — caller mints credentials, then consumes the token. */
export interface FlmuxEnrollmentGrant {
  tokenId: string;
  user: string;
}

/** `/api/model/path/*` methods gated by `allow_paths`. `list` is treated
 * as a read (directory-like enumeration of the same path). */
export type PathAccessMethod = "read" | "write" | "call";

export interface FlmuxWebModeAuthorizer {
  readonly cookieName: string;
  /** Underlying token store — the server uses it to mint sessions, consume
   * enrollment tokens, prune, and watch for external revokes. */
  readonly tokenStore: TokenStore;
  readonly userStore: UserStore;
  /** Resolve a presented token to a session context. Only `session` and
   * `machine` tokens resolve; `enrollment` tokens NEVER do (resolving one
   * would grant a full session without registering a passkey = bypass). */
  authorize(tokenValue: string): FlmuxAuthorizationContext | null;
  /** Validate a single-use enrollment token: must exist in the enrollment
   * namespace, be unexpired, and bind to an existing user. Does NOT consume
   * — caller consumes via `tokenStore.removeById` after a successful
   * registration (atomic winner-takes-all). */
  verifyEnrollmentToken(tokenValue: string): FlmuxEnrollmentGrant | null;
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
    tokenStore: options.tokenStore,
    userStore: options.userStore,
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
      // Enrollment tokens are a separate namespace — they grant the right to
      // register a passkey, never a session. Refusing them here is the
      // non-negotiable barrier against "valid enrollment link = full session".
      if (!tokenRecord || tokenRecord.kind === "enrollment") {
        return null;
      }

      if (isExpired(tokenRecord)) {
        return null;
      }

      const user = options.userStore.getUser(tokenRecord.user);
      if (!user) {
        return null;
      }

      return { user, tokenId: tokenRecord.id };
    },
    verifyEnrollmentToken(tokenValue) {
      if (!tokenValue) return null;
      const record = options.tokenStore.findByHash(hashToken(tokenValue));
      if (!record || record.kind !== "enrollment" || isExpired(record)) {
        return null;
      }
      if (!options.userStore.getUser(record.user)) {
        return null;
      }
      return { tokenId: record.id, user: record.user };
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
      if (user.denyPaneKinds.includes(kind)) {
        return false;
      }
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

function isExpired(token: FlmuxIssuedToken): boolean {
  if (!token.expiresAt) return false;
  const expiryMs = Date.parse(token.expiresAt);
  return Number.isNaN(expiryMs) || expiryMs <= Date.now();
}

/** Synthetic tokenId for `--dev-auth-as` contexts — never present in the token
 * store, so it must not enter the live-revoke registry (the store-watch sweep
 * closes any tracked socket whose tokenId it can't resolve). */
export const DEV_AUTH_TOKEN_ID = "dev-auth-as";

function resolveDevContext(userStore: UserStore, name: string): FlmuxAuthorizationContext {
  const existing = userStore.getUser(name);
  const user: FlmuxUser = existing ?? {
    name,
    handle: undefined,
    displayName: undefined,
    role: "dev",
    allowPaneKinds: "*",
    denyPaneKinds: [],
    allowPaths: "*",
    fsUnconfined: true,
    dirsRw: [],
    dirsRo: []
  };
  return { user, tokenId: DEV_AUTH_TOKEN_ID };
}
