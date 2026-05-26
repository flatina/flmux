import { mkdirSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { ExtensionFsBind, ExtensionFsPolicy } from "@flmux/extension-api";
import type { FlmuxUser } from "./userStore";

export interface FsPolicyResolver {
  /** Resolve a user's filesystem grant for the agent sandbox. */
  resolve(user: FlmuxUser): ExtensionFsPolicy;
}

/**
 * Single source for the agent sandbox binds (+ Phase-2 `/fs`). Each
 * `dirs_rw`/`dirs_ro` template is substituted, then **canonicalized and
 * required to resolve under the `.flmux_users` base** — so a hand-edited
 * `{flmux_users}/../etc` or symlinked source is rejected, not trusted. Real
 * prefix hidden behind a `/w`-rooted `virtual`.
 */
export function createFsPolicyResolver(usersRootDir: string): FsPolicyResolver {
  mkdirSync(usersRootDir, { recursive: true });
  const baseReal = realpathSync(usersRootDir);
  const basePrefix = baseReal.endsWith(sep) ? baseReal : baseReal + sep;

  function resolveEntry(template: string, handle: string, mode: "ro" | "rw"): ExtensionFsBind | null {
    const abs = resolve(template.replace(/\{flmux_users\}/g, baseReal).replace(/\{handle\}/g, handle));
    // Lexical pre-check so an escaping entry (`{flmux_users}/../etc`) is rejected
    // BEFORE we mkdir (don't create stray dirs outside the base).
    if (abs !== baseReal && !abs.startsWith(basePrefix)) {
      return null;
    }
    try {
      mkdirSync(abs, { recursive: true });
    } catch {
      /* provisioning best-effort; realpath below is the gate */
    }
    let canon: string;
    try {
      canon = realpathSync(abs);
    } catch {
      return null;
    }
    // Symlink-safe final containment (a symlinked component could still escape).
    if (canon !== baseReal && !canon.startsWith(basePrefix)) {
      return null;
    }
    const rel = canon === baseReal ? "" : canon.slice(basePrefix.length).split(sep).join("/");
    return { realPath: canon, mode, virtual: rel ? `/w/${rel}` : "/w" };
  }

  return {
    resolve(user) {
      if (user.fsUnconfined) {
        return { unconfined: true, binds: [] };
      }
      // Confined but unkeyable → no fs (handle keys per-user dirs).
      if (!user.handle) {
        return { unconfined: false, binds: [] };
      }
      // ro first, then rw, so a path granted both ends up rw (most-permissive).
      const byPath = new Map<string, ExtensionFsBind>();
      for (const t of user.dirsRo) {
        const b = resolveEntry(t, user.handle, "ro");
        if (b) byPath.set(b.realPath, b);
      }
      for (const t of user.dirsRw) {
        const b = resolveEntry(t, user.handle, "rw");
        if (b) byPath.set(b.realPath, b);
      }
      return { unconfined: false, binds: [...byPath.values()] };
    }
  };
}
