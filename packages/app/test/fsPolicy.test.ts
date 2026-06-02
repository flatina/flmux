import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsPolicyResolver } from "../src/main/auth/fsPolicy";
import type { FlmuxUser } from "../src/main/auth/userStore";

const OWN = "{flmux_users}/u/{name}";
const SHARED_SKILLS = "{flmux_users}/shared_skills";
const SHARED_RW = "{flmux_users}/shared_rw";

function mkUser(over: Partial<FlmuxUser>): FlmuxUser {
  return {
    name: "aB3-_xyz",
    handle: "webauthn-id",
    displayName: undefined,
    role: undefined,
    allowPaneKinds: "*",
    denyPaneKinds: [],
    allowPaths: "*",
    fsUnconfined: false,
    dirsRw: [],
    dirsRo: [],
    ...over
  };
}

function resolver() {
  return createFsPolicyResolver(mkdtempSync(join(tmpdir(), "fsp-")));
}

describe("fsPolicy resolver", () => {
  it("unconfined user → no binds, full fs", () => {
    expect(resolver().resolve(mkUser({ fsUnconfined: true }))).toEqual({ unconfined: true, binds: [] });
  });

  it("maps confined dirs to /w virtual paths with modes", () => {
    const p = resolver().resolve(mkUser({ dirsRw: [OWN, SHARED_RW], dirsRo: [SHARED_SKILLS] }));
    expect(p.unconfined).toBe(false);
    const byVirtual = Object.fromEntries(p.binds.map((b) => [b.virtual, b.mode]));
    expect(byVirtual).toEqual({ "/w/u/aB3-_xyz": "rw", "/w/shared_rw": "rw", "/w/shared_skills": "ro" });
  });

  it("drops a template with an unresolved placeholder (fail-closed)", () => {
    // fs key migrated handle→name; a stale `{handle}` template must not resolve.
    const p = resolver().resolve(mkUser({ dirsRw: ["{flmux_users}/u/{handle}", OWN] }));
    expect(p.binds.map((b) => b.virtual)).toEqual(["/w/u/aB3-_xyz"]);
  });

  it("rejects entries that escape the base", () => {
    const p = resolver().resolve(mkUser({ dirsRw: ["{flmux_users}/../../../etc", OWN] }));
    expect(p.binds.map((b) => b.virtual)).toEqual(["/w/u/aB3-_xyz"]);
  });

  it("same path granted ro+rw resolves to rw", () => {
    const p = resolver().resolve(mkUser({ dirsRo: [SHARED_RW], dirsRw: [SHARED_RW] }));
    expect(p.binds).toEqual([{ realPath: expect.any(String), mode: "rw", virtual: "/w/shared_rw" }]);
  });
});
