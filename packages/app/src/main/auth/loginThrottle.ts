import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Per-username failed-login lockout. Persistent — an in-memory counter resets
 * on restart, which an attacker who can bounce the process could use to reset
 * the brute-force budget. Records failures for any submitted username (so a
 * locked-out response can't distinguish real from unknown accounts), and a
 * stale-entry sweep on write bounds growth from a random-username flood.
 * Synchronous (instance lock + no await) → atomic. */
export interface LoginThrottle {
  /** ms until the username may retry, or 0 if not locked. */
  retryAfterMs(username: string, now?: number): number;
  recordFailure(username: string, now?: number): void;
  recordSuccess(username: string): void;
}

interface Entry {
  failures: number;
  windowStart: number;
  lockedUntil: number;
}

export function createLoginThrottle(filePath: string, opts: { maxFailures: number; lockMs: number }): LoginThrottle {
  function load(): Map<string, Entry> {
    const byUser = new Map<string, Entry>();
    if (!existsSync(filePath)) return byUser;
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, Partial<Entry>>;
      for (const [user, e] of Object.entries(parsed)) {
        if (e && typeof e.failures === "number" && typeof e.lockedUntil === "number") {
          byUser.set(user, { failures: e.failures, windowStart: e.windowStart ?? 0, lockedUntil: e.lockedUntil });
        }
      }
    } catch {
      /* corrupt → start clean (throttle is recoverable state, not config) */
    }
    return byUser;
  }

  // Drop entries that are neither locked nor recently active — bounds the file
  // against a random-username flood (entries self-expire one lockMs window after
  // their last failure / lock).
  function sweep(byUser: Map<string, Entry>, now: number) {
    for (const [user, e] of byUser) {
      if (e.lockedUntil <= now && now - e.windowStart > opts.lockMs) byUser.delete(user);
    }
  }

  function persist(byUser: Map<string, Entry>) {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    writeFileSync(tmpPath, JSON.stringify(Object.fromEntries(byUser)), { encoding: "utf8", mode: 0o600 });
    renameSync(tmpPath, filePath);
  }

  return {
    retryAfterMs(username, now = Date.now()) {
      const e = load().get(username);
      if (!e || e.lockedUntil <= now) return 0;
      return e.lockedUntil - now;
    },
    recordFailure(username, now = Date.now()) {
      const byUser = load();
      sweep(byUser, now);
      const e = byUser.get(username) ?? { failures: 0, windowStart: now, lockedUntil: 0 };
      if (e.lockedUntil > now) return; // already locked — don't extend on each blocked try
      if (now - e.windowStart > opts.lockMs) {
        e.failures = 0; // failures aged out of the counting window
        e.windowStart = now;
      }
      e.failures += 1;
      if (e.failures >= opts.maxFailures) {
        e.lockedUntil = now + opts.lockMs;
        e.failures = 0; // fresh budget after the lock expires
      }
      byUser.set(username, e);
      persist(byUser);
    },
    recordSuccess(username) {
      const byUser = load();
      if (byUser.delete(username)) persist(byUser);
    }
  };
}
