import { Secret, TOTP } from "otpauth";

// RFC 6238 defaults — universal authenticator-app compatibility.
const ALGORITHM = "SHA1";
const DIGITS = 6;
const PERIOD = 30;

/** New 160-bit base32 secret. */
export function generateTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

/** otpauth:// URI for QR / manual entry. `label` = account, `issuer` = app. */
export function totpUri(opts: { secret: string; label: string; issuer: string }): string {
  return new TOTP({
    issuer: opts.issuer,
    label: opts.label,
    secret: Secret.fromBase32(opts.secret),
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: PERIOD
  }).toString();
}

/** Validate `code` against `secret` within ±windowSteps; returns the matched
 * absolute counter (period index since epoch) on success, else null. The caller
 * enforces replay by rejecting a matched step ≤ the last consumed one — a wider
 * window keeps earlier-step codes briefly valid. `timestamp` injectable for tests. */
export function verifyTotpStep(opts: {
  secret: string;
  code: string;
  windowSteps: number;
  timestamp?: number;
}): number | null {
  let secret: Secret;
  try {
    secret = Secret.fromBase32(opts.secret);
  } catch {
    return null;
  }
  const totp = new TOTP({ secret, algorithm: ALGORITHM, digits: DIGITS, period: PERIOD });
  const timestamp = opts.timestamp ?? Date.now();
  const delta = totp.validate({ token: opts.code, timestamp, window: opts.windowSteps });
  if (delta === null) return null;
  return TOTP.counter({ period: PERIOD, timestamp }) + delta;
}
