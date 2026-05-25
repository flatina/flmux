import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type WebAuthnCredential
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { FlmuxPasskeyCredential } from "./webauthnStore";

/** RP config derived from the public origin. RP ID = the full host (most
 * restrictive; `*.ts.net` is a public suffix so a parent RP ID is unsafe).
 * origin = the full https origin the browser sees behind Funnel. */
export interface WebauthnRpConfig {
  rpName: string;
  rpID: string;
  origin: string;
}

export function resolveWebauthnRpConfig(publicOrigin: string | undefined, rpName = "flmux"): WebauthnRpConfig {
  if (!publicOrigin) {
    throw new Error("FLMUX_PUBLIC_ORIGIN is required for passkey auth (RP ID/origin)");
  }
  let url: URL;
  try {
    url = new URL(publicOrigin);
  } catch {
    throw new Error(`FLMUX_PUBLIC_ORIGIN is not a valid URL: '${publicOrigin}'`);
  }
  return { rpName, rpID: url.hostname, origin: url.origin };
}

export async function buildRegistrationOptions(opts: {
  rp: WebauthnRpConfig;
  userHandle: string;
  userName: string;
  existing: readonly FlmuxPasskeyCredential[];
}) {
  return generateRegistrationOptions({
    rpName: opts.rp.rpName,
    rpID: opts.rp.rpID,
    userName: opts.userName,
    userID: isoBase64URL.toBuffer(opts.userHandle),
    attestationType: "none",
    // Block re-registering an authenticator already on the account.
    excludeCredentials: opts.existing.map((c) => ({
      id: c.credentialId,
      transports: c.transports
    })),
    authenticatorSelection: {
      // Discoverable credential — required for usernameless login.
      residentKey: "required",
      requireResidentKey: true,
      // Passwordless primary factor: never accept UV=false authenticators.
      userVerification: "required"
    }
  });
}

export async function verifyRegistration(opts: {
  rp: WebauthnRpConfig;
  response: RegistrationResponseJSON;
  expectedChallenge: string;
}) {
  return verifyRegistrationResponse({
    response: opts.response,
    expectedChallenge: opts.expectedChallenge,
    expectedOrigin: opts.rp.origin,
    expectedRPID: opts.rp.rpID,
    requireUserVerification: true
  });
}

export async function buildAuthenticationOptions(opts: { rp: WebauthnRpConfig }) {
  return generateAuthenticationOptions({
    rpID: opts.rp.rpID,
    // Usernameless / discoverable: empty allowCredentials lets the browser
    // surface the user's resident key for this RP without a typed username.
    allowCredentials: [],
    userVerification: "required"
  });
}

export async function verifyAuthentication(opts: {
  rp: WebauthnRpConfig;
  response: AuthenticationResponseJSON;
  expectedChallenge: string;
  credential: FlmuxPasskeyCredential;
}) {
  return verifyAuthenticationResponse({
    response: opts.response,
    expectedChallenge: opts.expectedChallenge,
    expectedOrigin: opts.rp.origin,
    expectedRPID: opts.rp.rpID,
    requireUserVerification: true,
    credential: {
      id: opts.credential.credentialId,
      publicKey: isoBase64URL.toBuffer(opts.credential.publicKey),
      counter: opts.credential.signCount,
      transports: opts.credential.transports
    }
  });
}

export function encodePublicKey(publicKey: WebAuthnCredential["publicKey"]): string {
  return isoBase64URL.fromBuffer(publicKey);
}

export function normalizeTransports(transports: unknown): AuthenticatorTransportFuture[] {
  if (!Array.isArray(transports)) return [];
  return transports.filter((t): t is AuthenticatorTransportFuture => typeof t === "string");
}
