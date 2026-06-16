import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import type { FlmuxWebModeAuthorizer } from "../webModeAuth";
import { generateToken, hashToken } from "./tokenFormat";
import {
  CEREMONY_COOKIE,
  SESSION_COOKIE,
  clearCeremonyCookie,
  clearSessionCookie,
  isSecureRequest,
  readCookie,
  serializeCeremonyCookie,
  serializeSessionCookie
} from "./cookies";
import {
  buildAuthenticationOptions,
  buildRegistrationOptions,
  encodePublicKey,
  normalizeTransports,
  resolveWebauthnRpConfig,
  verifyAuthentication,
  verifyRegistration,
  type WebauthnRpConfig
} from "./webauthn";
import { createChallengeStore, createWebauthnStore, type ChallengeStore, type WebauthnStore } from "./webauthnStore";
import type { TotpStore } from "./totpStore";
import type { LoginThrottle } from "./loginThrottle";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (default; overridable)
// Recovery-code login is a break-glass path → short session, just enough to
// re-enroll. (Capability-scoping to re-enroll-only is a documented follow-up.)
const RECOVERY_SESSION_TTL_MS = 10 * 60 * 1000;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

/** Tracks every open `/rpc` connection by the session tokenId that opened it,
 * so logout / external revoke can force-close live sockets. */
export interface RpcConnectionRegistry {
  register(tokenId: string, close: () => void): () => void;
  closeForToken(tokenId: string): void;
}

export interface WebauthnAuthService {
  registerRpcConnection(tokenId: string, close: () => void): () => void;
  handleRegisterOptions(request: Request): Promise<Response>;
  handleRegisterVerify(request: Request): Promise<Response>;
  handleAuthenticateOptions(request: Request): Promise<Response>;
  handleAuthenticateVerify(request: Request): Promise<Response>;
  handleTotpAuthenticate(request: Request): Promise<Response>;
  handleTotpRecovery(request: Request): Promise<Response>;
  handleLogout(request: Request): Promise<Response>;
  dispose(): void;
}

export function createWebauthnAuthService(options: {
  authorizer: FlmuxWebModeAuthorizer;
  webauthnFile: string;
  tokensFile: string;
  publicOrigin: string | undefined;
  /** Closed-network TOTP front-door (optional; enabled per deployment). */
  totpStore?: TotpStore;
  totpWindowSteps?: number;
  /** Per-username lockout for TOTP/recovery login — the brute-force control;
   * required (not optional) so it can't be silently dropped while TOTP is on. */
  throttle: LoginThrottle;
  /** Minted session lifetime (ms). Default 30d. */
  sessionTtlMs?: number;
  /** Enabled methods — passkey RP config is built only when passkey is on, so a
   * TOTP-only deployment boots without FLMUX_PUBLIC_ORIGIN. */
  authMethods?: string[];
}): WebauthnAuthService {
  const passkeyEnabled = (options.authMethods ?? ["passkey"]).includes("passkey");
  const rp: WebauthnRpConfig | null = passkeyEnabled ? resolveWebauthnRpConfig(options.publicOrigin) : null;
  const sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
  const webauthnStore: WebauthnStore = createWebauthnStore(options.webauthnFile);
  const challenges: ChallengeStore & { dispose(): void } = createChallengeStore();
  const tokenStore = options.authorizer.tokenStore;
  const userStore = options.authorizer.userStore;

  // tokenId → set of close fns for its live /rpc connections.
  const liveByToken = new Map<string, Set<() => void>>();

  // Watch the auth DIR (not the file) so an external CLI revoke closes live
  // sockets. Token writes are tmp+rename (atomic) which swap the file inode and
  // break a file-level watch after the first event; a directory watch survives
  // renames and fires even before the file first exists. Debounced (rename
  // fires multiple events); on change we reload the index and close any tracked
  // tokenId now gone.
  let watcher: FSWatcher | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const tokensDir = dirname(options.tokensFile);
  const tokensName = basename(options.tokensFile);
  try {
    mkdirSync(tokensDir, { recursive: true });
    watcher = watch(tokensDir, (_event, filename) => {
      if (filename && filename.toString() !== tokensName) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        tokenStore.reload();
        for (const tokenId of [...liveByToken.keys()]) {
          if (!tokenStore.findById(tokenId)) closeLive(tokenId);
        }
      }, 150);
    });
  } catch {
    // Best-effort live-revoke aid; the per-request mtime cache still rejects
    // revoked tokens on the next call regardless.
  }

  function closeLive(tokenId: string) {
    const set = liveByToken.get(tokenId);
    if (!set) return;
    liveByToken.delete(tokenId);
    for (const close of set) {
      try {
        close();
      } catch {
        /* swallow */
      }
    }
  }

  function json(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
    return new Response(JSON.stringify(body), {
      status: init?.status ?? 200,
      headers: { ...JSON_HEADERS, ...(init?.headers ?? {}) }
    });
  }

  function err(message: string, status = 400, headers?: Record<string, string>): Response {
    return json({ ok: false, error: message }, { status, headers });
  }

  /** 429 (+ Retry-After) if the username is locked out, else null. */
  function lockedResponse(username: string): Response | null {
    const wait = options.throttle.retryAfterMs(username);
    if (wait <= 0) return null;
    return err("Too many attempts; try again later", 429, { "retry-after": String(Math.ceil(wait / 1000)) });
  }

  /** Mint a durable session token + set its cookie — the single mint path shared
   * by every front-door (passkey / totp / recovery). authorize() validates it
   * unchanged on every subsequent request. */
  function mintSession(user: string, label: string, ttlMs: number, secure: boolean): Response {
    const minted = generateToken();
    tokenStore.append({
      id: minted.id,
      user,
      tokenHash: minted.hash,
      tokenPrefix: minted.prefix,
      createdAt: new Date().toISOString(),
      kind: "session",
      label,
      expiresAt: new Date(Date.now() + ttlMs).toISOString()
    });
    return json({ ok: true }, { headers: { "set-cookie": serializeSessionCookie(minted.value, secure) } });
  }

  /** Authz for credential registration: a still-valid enrollment token (in
   * its own namespace) OR an existing session cookie. Returns the bound user
   * name plus, when present, the enrollment tokenId to consume on success. */
  function resolveRegisterAuthz(
    request: Request,
    bodyToken: string | undefined
  ): {
    user: string;
    enrollmentTokenId?: string;
  } | null {
    if (bodyToken) {
      const grant = options.authorizer.verifyEnrollmentToken(bodyToken);
      if (grant) return { user: grant.user, enrollmentTokenId: grant.tokenId };
      return null;
    }
    const sessionToken = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
    if (!sessionToken) return null;
    const ctx = options.authorizer.authorize(sessionToken);
    return ctx ? { user: ctx.user.name } : null;
  }

  // Pre-auth endpoint: bound the body well below the (upload-sized) global cap.
  // Passkey ceremony payloads are a few KB; oversized/invalid → {} → 400.
  async function readJson(request: Request): Promise<Record<string, unknown>> {
    const reader = request.body?.getReader();
    if (!reader) return {};
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > 64 * 1024) {
          await reader.cancel();
          return {};
        }
        chunks.push(value);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  return {
    registerRpcConnection(tokenId, close) {
      let set = liveByToken.get(tokenId);
      if (!set) {
        set = new Set();
        liveByToken.set(tokenId, set);
      }
      set.add(close);
      return () => {
        const current = liveByToken.get(tokenId);
        if (!current) return;
        current.delete(close);
        if (current.size === 0) liveByToken.delete(tokenId);
      };
    },

    async handleRegisterOptions(request) {
      if (!rp) return err("Passkey auth is disabled", 404);
      const body = await readJson(request);
      const token = typeof body.token === "string" ? body.token : undefined;
      const authz = resolveRegisterAuthz(request, token);
      if (!authz) return err("Not authorized to register a passkey", 401);

      const user = userStore.getUser(authz.user);
      if (!user?.handle) return err("User has no stable handle; recreate the account", 409);

      const existing = webauthnStore.listForUser(user.name);
      const options = await buildRegistrationOptions({
        rp,
        userHandle: user.handle,
        userName: user.name,
        existing
      });
      const ceremonyId = challenges.put({ challenge: options.challenge, kind: "register", user: user.name });
      const secure = isSecureRequest(request);
      return json(options, { headers: { "set-cookie": serializeCeremonyCookie(ceremonyId, secure) } });
    },

    async handleRegisterVerify(request) {
      if (!rp) return err("Passkey auth is disabled", 404);
      const secure = isSecureRequest(request);
      const ceremonyId = readCookie(request.headers.get("cookie"), CEREMONY_COOKIE);
      const clearCookie = clearCeremonyCookie(secure);
      if (!ceremonyId) return err("No active ceremony", 400, { "set-cookie": clearCookie });
      const challenge = challenges.take(ceremonyId);
      if (!challenge || challenge.kind !== "register" || !challenge.user) {
        return err("Ceremony expired", 400, { "set-cookie": clearCookie });
      }

      const body = await readJson(request);
      const token = typeof body.token === "string" ? body.token : undefined;
      const authz = resolveRegisterAuthz(request, token);
      // Authz must still hold AND target the same user the challenge was issued for.
      if (!authz || authz.user !== challenge.user) {
        return err("Not authorized to register a passkey", 401, { "set-cookie": clearCookie });
      }

      const verification = await verifyRegistration({
        rp,
        response: body.response as Parameters<typeof verifyRegistration>[0]["response"],
        expectedChallenge: challenge.challenge
      }).catch((e: unknown) => {
        return { verified: false as const, error: e instanceof Error ? e.message : String(e) };
      });
      if (!("verified" in verification) || !verification.verified || !verification.registrationInfo) {
        const reason = "error" in verification ? verification.error : "verification failed";
        return err(`Registration verification failed: ${reason}`, 400, { "set-cookie": clearCookie });
      }

      const info = verification.registrationInfo;
      const credentialId = info.credential.id;
      if (webauthnStore.findByCredentialId(credentialId)) {
        return err("This authenticator is already registered", 409, { "set-cookie": clearCookie });
      }

      const regResponse = body.response as { response?: { transports?: unknown } } | undefined;
      const transports = normalizeTransports(regResponse?.response?.transports);

      // Consume the enrollment token FIRST (atomic winner) so a racing second
      // verify can't also register against the same one-time grant.
      if (authz.enrollmentTokenId && !tokenStore.removeById(authz.enrollmentTokenId)) {
        return err("Enrollment token already used", 409, { "set-cookie": clearCookie });
      }

      webauthnStore.add({
        user: challenge.user,
        credentialId,
        publicKey: encodePublicKey(info.credential.publicKey),
        signCount: info.credential.counter,
        transports,
        label: typeof body.label === "string" ? body.label : "passkey",
        createdAt: new Date().toISOString()
      });

      return json({ ok: true }, { headers: { "set-cookie": clearCookie } });
    },

    async handleAuthenticateOptions(request) {
      if (!rp) return err("Passkey auth is disabled", 404);
      const options = await buildAuthenticationOptions({ rp });
      const ceremonyId = challenges.put({ challenge: options.challenge, kind: "authenticate" });
      const secure = isSecureRequest(request);
      return json(options, { headers: { "set-cookie": serializeCeremonyCookie(ceremonyId, secure) } });
    },

    async handleAuthenticateVerify(request) {
      if (!rp) return err("Passkey auth is disabled", 404);
      const secure = isSecureRequest(request);
      const ceremonyId = readCookie(request.headers.get("cookie"), CEREMONY_COOKIE);
      const clearCookie = clearCeremonyCookie(secure);
      if (!ceremonyId) return err("No active ceremony", 400, { "set-cookie": clearCookie });
      const challenge = challenges.take(ceremonyId);
      if (!challenge || challenge.kind !== "authenticate") {
        return err("Ceremony expired", 400, { "set-cookie": clearCookie });
      }

      const response = (await readJson(request)) as Parameters<typeof verifyAuthentication>[0]["response"] &
        Record<string, unknown>;
      const credentialId = typeof response.id === "string" ? response.id : null;
      if (!credentialId) return err("Malformed assertion", 400, { "set-cookie": clearCookie });

      const credential = webauthnStore.findByCredentialId(credentialId);
      if (!credential || credential.needsReview) {
        return err("Unknown or disabled credential", 401, { "set-cookie": clearCookie });
      }
      const user = userStore.getUser(credential.user);
      if (!user) return err("Account not found", 401, { "set-cookie": clearCookie });

      const verification = await verifyAuthentication({
        rp,
        response,
        expectedChallenge: challenge.challenge,
        credential
      }).catch((e: unknown) => ({ verified: false as const, error: e instanceof Error ? e.message : String(e) }));
      if (!("verified" in verification) || !verification.verified || !("authenticationInfo" in verification)) {
        return err("Authentication failed", 401, { "set-cookie": clearCookie });
      }

      const authInfo = verification.authenticationInfo;
      // Passwordless primary factor: reject UV=false even if the library let
      // it through (defense in depth atop requireUserVerification).
      if (!authInfo.userVerified) {
        return err("User verification required", 401, { "set-cookie": clearCookie });
      }

      // Clone/replay defense lives in SimpleWebAuthn: verifyAuthentication() got
      // the stored counter, so it already rejected a signCount regression (with
      // 0-counter authenticators correctly exempted) before reaching here. Just
      // record the advanced counter. (Admin-disable via needsReview is Stage 2.)
      webauthnStore.updateUsage(credentialId, authInfo.newCounter, new Date().toISOString());

      // Mint the session (shared path) — authorize() validates it unchanged after.
      return mintSession(credential.user, "passkey", sessionTtlMs, secure);
    },

    // TOTP front-door: username + 6-digit code → verify+consume → mint session
    // (same currency as passkey). Throttle/verify run for any username (unknown
    // accounts get the same 401/lockout path) so the response can't enumerate
    // users; per-username lockout bounds brute force of the 10⁶ code space.
    async handleTotpAuthenticate(request) {
      const secure = isSecureRequest(request);
      const fail = () => err("Invalid credentials", 401);
      if (!options.totpStore) return fail();
      const body = await readJson(request);
      const username = typeof body.username === "string" ? body.username.trim() : "";
      const code = typeof body.code === "string" ? body.code.trim() : "";
      if (!username || !code) return fail();
      const locked = lockedResponse(username);
      if (locked) return locked;
      // verifyAndConsume returns false for an unknown user (no enrollment).
      if (!options.totpStore.verifyAndConsume(username, code, options.totpWindowSteps ?? 1)) {
        options.throttle.recordFailure(username);
        return fail();
      }
      if (!userStore.getUser(username)) return fail(); // orphan enrollment (account gone)
      options.throttle.recordSuccess(username);
      return mintSession(username, "totp", sessionTtlMs, secure);
    },

    // Break-glass: a single-use recovery code → short-lived session. (Capability
    // scoping to re-enroll-only is a follow-up; re-enroll itself is admin CLI.)
    async handleTotpRecovery(request) {
      const secure = isSecureRequest(request);
      const fail = () => err("Invalid credentials", 401);
      if (!options.totpStore) return fail();
      const body = await readJson(request);
      const username = typeof body.username === "string" ? body.username.trim() : "";
      const code = typeof body.code === "string" ? body.code : "";
      if (!username || !code) return fail();
      const locked = lockedResponse(username);
      if (locked) return locked;
      if (!options.totpStore.consumeRecoveryCode(username, code)) {
        options.throttle.recordFailure(username);
        return fail();
      }
      if (!userStore.getUser(username)) return fail(); // orphan enrollment (account gone)
      options.throttle.recordSuccess(username);
      return mintSession(username, "totp-recovery", RECOVERY_SESSION_TTL_MS, secure);
    },

    async handleLogout(request) {
      const secure = isSecureRequest(request);
      const sessionToken = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
      if (sessionToken) {
        const record = tokenStore.findByHash(hashToken(sessionToken));
        if (record && record.kind === "session") {
          closeLive(record.id);
          tokenStore.removeById(record.id);
        }
      }
      return json({ ok: true }, { headers: { "set-cookie": clearSessionCookie(secure) } });
    },

    dispose() {
      if (debounce) clearTimeout(debounce);
      watcher?.close();
      challenges.dispose();
    }
  };
}
