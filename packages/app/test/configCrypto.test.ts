import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { CONFIG_KEY_BYTES, decryptEnvelope, encryptEnvelope, isEncValue } from "@flmux/extension-api/config-crypto";

const PREFIX = "${enc:";

function key() {
  return randomBytes(CONFIG_KEY_BYTES);
}

/** Flip one byte of the envelope (offsets: 0=version, 1=flags, 2..5=keyId,
 * 6..17=nonce, 18..33=tag, 34+=ciphertext). */
function tamper(encValue: string, offset: number): string {
  const buf = Buffer.from(encValue.slice(PREFIX.length, -1), "base64url");
  buf[offset]! ^= 0xff;
  return `${PREFIX}${buf.toString("base64url")}}`;
}

describe("configCrypto", () => {
  it("roundtrips (no aad)", () => {
    const k = key();
    const env = encryptEnvelope("hunter2", { key: k });
    expect(isEncValue(env)).toBe(true);
    expect(env.startsWith(PREFIX)).toBe(true);
    expect(decryptEnvelope(env, { key: k })).toBe("hunter2");
  });

  it("roundtrips with matching aad", () => {
    const k = key();
    const env = encryptEnvelope("pw", { key: k, aad: "conn:djpp3" });
    expect(decryptEnvelope(env, { key: k, aad: "conn:djpp3" })).toBe("pw");
  });

  it("rejects a wrong key (keyId mismatch)", () => {
    const env = encryptEnvelope("pw", { key: key() });
    expect(() => decryptEnvelope(env, { key: key() })).toThrow(/key mismatch/);
  });

  it("aad presence must match the envelope", () => {
    const k = key();
    const bound = encryptEnvelope("pw", { key: k, aad: "ctx" });
    const plain = encryptEnvelope("pw", { key: k });
    expect(() => decryptEnvelope(bound, { key: k })).toThrow(/aad required/);
    expect(() => decryptEnvelope(plain, { key: k, aad: "ctx" })).toThrow(/unexpected aad/);
    expect(() => decryptEnvelope(bound, { key: k, aad: "other" })).toThrow(/decryption failed/);
  });

  it("rejects tampering (header in AAD + GCM tag)", () => {
    const k = key();
    const env = encryptEnvelope("secret-value", { key: k });
    expect(() => decryptEnvelope(tamper(env, 0), { key: k })).toThrow(/unsupported version/); // version
    expect(() => decryptEnvelope(tamper(env, 2), { key: k })).toThrow(/key mismatch/); // keyId
    expect(() => decryptEnvelope(tamper(env, 6), { key: k })).toThrow(/decryption failed/); // nonce
    expect(() => decryptEnvelope(tamper(env, 18), { key: k })).toThrow(/decryption failed/); // tag
    expect(() => decryptEnvelope(tamper(env, 34), { key: k })).toThrow(/decryption failed/); // ciphertext
  });

  it("rejects malformed / short / non-canonical envelopes", () => {
    const k = key();
    expect(() => decryptEnvelope(`${PREFIX}!!!notb64!!!}`, { key: k })).toThrow(/malformed/);
    expect(() => decryptEnvelope(`${PREFIX}AAAA}`, { key: k })).toThrow(/malformed/); // too short
  });

  it("requires a 32-byte key", () => {
    expect(() => encryptEnvelope("x", { key: randomBytes(16) })).toThrow(/32 bytes/);
  });
});
