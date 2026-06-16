import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLoginThrottle } from "../src/main/auth/loginThrottle";

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "throttle-"));
  return { path: join(dir, "throttle.json"), dir };
}

describe("loginThrottle", () => {
  it("locks after maxFailures and unlocks after lockMs", () => {
    const { path, dir } = tmp();
    try {
      const t = createLoginThrottle(path, { maxFailures: 3, lockMs: 1000 });
      const now = 10_000;
      t.recordFailure("u", now);
      t.recordFailure("u", now);
      expect(t.retryAfterMs("u", now)).toBe(0); // 2 < 3
      t.recordFailure("u", now); // 3rd → lock
      expect(t.retryAfterMs("u", now)).toBe(1000);
      expect(t.retryAfterMs("u", now + 999)).toBe(1);
      expect(t.retryAfterMs("u", now + 1000)).toBe(0); // expired
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("success clears the failure count", () => {
    const { path, dir } = tmp();
    try {
      const t = createLoginThrottle(path, { maxFailures: 3, lockMs: 1000 });
      t.recordFailure("u");
      t.recordFailure("u");
      t.recordSuccess("u");
      t.recordFailure("u");
      t.recordFailure("u"); // only 2 since the reset → not locked
      expect(t.retryAfterMs("u")).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists the lock across instances (survives restart)", () => {
    const { path, dir } = tmp();
    try {
      const now = 5000;
      const a = createLoginThrottle(path, { maxFailures: 1, lockMs: 2000 });
      a.recordFailure("u", now); // 1 → lock
      const b = createLoginThrottle(path, { maxFailures: 1, lockMs: 2000 }); // reopen = restart
      expect(b.retryAfterMs("u", now + 500)).toBe(1500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
