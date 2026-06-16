import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Secret, TOTP } from "otpauth";
import { generateTotpSecret, totpUri, verifyTotpStep } from "../src/main/auth/totp";
import { createTotpStore } from "../src/main/auth/totpStore";
import { generateRecoveryCodes, normalizeRecoveryCode } from "../src/main/auth/recoveryCodes";

// RFC 6238 Appendix B (SHA1) — ASCII "12345678901234567890" in base32.
const RFC_SECRET_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totp verifier", () => {
  it("matches the RFC 6238 SHA1 vector (T=59s → 287082, counter 1)", () => {
    expect(verifyTotpStep({ secret: RFC_SECRET_B32, code: "287082", windowSteps: 0, timestamp: 59_000 })).toBe(1);
  });
  it("rejects a wrong code", () => {
    expect(verifyTotpStep({ secret: RFC_SECRET_B32, code: "000000", windowSteps: 1, timestamp: 59_000 })).toBeNull();
  });
  it("rejects a malformed secret", () => {
    expect(verifyTotpStep({ secret: "not!base32!", code: "287082", windowSteps: 1, timestamp: 59_000 })).toBeNull();
  });
  it("generates a base32 secret + a valid otpauth uri", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    const uri = totpUri({ secret, label: "alice", issuer: "flmux" });
    expect(uri).toStartWith("otpauth://totp/");
    expect(uri).toContain(`secret=${secret}`);
  });
});

describe("totpStore", () => {
  function tmpStore() {
    const dir = mkdtempSync(join(tmpdir(), "totp-test-"));
    return { path: join(dir, "totp.toml"), dir };
  }

  it("verifyAndConsume accepts a fresh code then rejects its replay", () => {
    const { path, dir } = tmpStore();
    try {
      const store = createTotpStore(path);
      const secret = generateTotpSecret();
      store.set({ user: "alice", secret, lastUsedStep: 0, recoveryHashes: [], createdAt: new Date().toISOString() });
      const code = new TOTP({ secret: Secret.fromBase32(secret), algorithm: "SHA1", digits: 6, period: 30 }).generate();
      expect(store.verifyAndConsume("alice", code, 1)).toBe(true);
      expect(store.verifyAndConsume("alice", code, 1)).toBe(false); // replay: step ≤ lastUsedStep
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("consumeRecoveryCode is single-use + formatting-tolerant", () => {
    const { path, dir } = tmpStore();
    try {
      const store = createTotpStore(path);
      const { codes, hashes } = generateRecoveryCodes(3);
      store.set({
        user: "bob",
        secret: generateTotpSecret(),
        lastUsedStep: 0,
        recoveryHashes: hashes,
        createdAt: new Date().toISOString()
      });
      // Tolerates lowercase / stripped separators (normalize on both sides).
      expect(store.consumeRecoveryCode("bob", codes[0]!.toLowerCase().replace(/-/g, ""))).toBe(true);
      expect(store.consumeRecoveryCode("bob", codes[0]!)).toBe(false); // already consumed
      expect(store.consumeRecoveryCode("bob", codes[1]!)).toBe(true); // others still valid
      expect(store.consumeRecoveryCode("bob", "00000-00000-00000-00000")).toBe(false); // unknown
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("recoveryCodes", () => {
  it("generates N grouped Crockford codes ≥100-bit, plus matching hashes", () => {
    const { codes, hashes } = generateRecoveryCodes(10);
    expect(codes.length).toBe(10);
    expect(hashes.length).toBe(10);
    for (const c of codes) {
      // 20 Crockford chars (×5 bits = 100), grouped in 5s with dashes.
      expect(c.replace(/-/g, "")).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/);
      expect(c).toMatch(/^.{5}-.{5}-.{5}-.{5}$/);
    }
    expect(new Set(codes).size).toBe(10); // unique
  });
  it("normalizeRecoveryCode folds case, separators, and I/L/O look-alikes", () => {
    expect(normalizeRecoveryCode("abcde-fghjk")).toBe("ABCDEFGHJK");
    expect(normalizeRecoveryCode("O0 I1 L1")).toBe("001111");
    expect(normalizeRecoveryCode(normalizeRecoveryCode("o0-i1"))).toBe(normalizeRecoveryCode("o0-i1")); // idempotent
  });
});
