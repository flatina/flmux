/** Cookie helpers shared by the request authorizer and the passkey auth
 * service. `Secure` is conditional on real proto (X-Forwarded-Proto: https,
 * set by Funnel) so the cookie still reaches plain-http dev / loopback. */

export const SESSION_COOKIE = "flmux_web_token";
/** Short-lived temp cookie binding a ceremony to its server-side challenge.
 * Distinct name from the session cookie so the two never collide. */
export const CEREMONY_COOKIE = "flmux_webauthn_ceremony";

const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60; // 30 days
const CEREMONY_MAX_AGE_S = 5 * 60; // 5 minutes

export function readCookie(rawCookieHeader: string | null, cookieName: string): string | null {
  if (!rawCookieHeader) return null;
  for (const entry of rawCookieHeader.split(";")) {
    const [rawName, ...rawValue] = entry.trim().split("=");
    if (rawName !== cookieName) continue;
    try {
      return decodeURIComponent(rawValue.join("="));
    } catch {
      return null; // malformed %-encoding → treat as absent (callers must not throw)
    }
  }
  return null;
}

export function isSecureRequest(request: Request): boolean {
  const fwdProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const proto = fwdProto ?? new URL(request.url).protocol.replace(/:$/, "");
  return proto === "https";
}

/** Persistent session cookie. SameSite=Lax (not Strict): the human `?token=`
 * fallback is gone, so a top-level navigation from an external link must still
 * carry the cookie or a valid session would look logged-out. Lax keeps
 * cross-site POSTs cookie-less (CSRF defense, with the origin allowlist). */
export function serializeSessionCookie(value: string, secure: boolean): string {
  return (
    `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${SESSION_MAX_AGE_S}${secure ? "; Secure" : ""}`
  );
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function serializeCeremonyCookie(value: string, secure: boolean): string {
  return (
    `${CEREMONY_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${CEREMONY_MAX_AGE_S}${secure ? "; Secure" : ""}`
  );
}

export function clearCeremonyCookie(secure: boolean): string {
  return `${CEREMONY_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}
