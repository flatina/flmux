import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUserStore } from "../src/main/auth/userStore";

function storeWith(toml: string) {
  const f = join(mkdtempSync(join(tmpdir(), "us-")), "users.toml");
  writeFileSync(f, toml, "utf8");
  return createUserStore(f);
}

describe("userStore role presets + handle", () => {
  it("dev preset → unconfined + terminal, no dirs", () => {
    const u = storeWith(`[[users]]\nname="d"\nrole="dev"\nhandle="h1"\n`).getUser("d")!;
    expect(u.fsUnconfined).toBe(true);
    expect(u.allowPaneKinds).toBe("*");
    expect(u.denyPaneKinds).toEqual([]);
    expect(u.dirsRw).toEqual([]);
  });

  it("tech preset → no terminal, own+skills+shared_rw", () => {
    const u = storeWith(`[[users]]\nname="t"\nrole="tech"\nhandle="h2"\n`).getUser("t")!;
    expect(u.fsUnconfined).toBe(false);
    expect(u.denyPaneKinds).toEqual(["terminal"]);
    expect(u.dirsRw).toEqual(["{flmux_users}/u/{name}", "{flmux_users}/shared_skills", "{flmux_users}/shared_rw"]);
  });

  it("user preset → no terminal, own+shared_rw (no skills)", () => {
    const u = storeWith(`[[users]]\nname="x"\nrole="user"\nhandle="h3"\n`).getUser("x")!;
    expect(u.denyPaneKinds).toEqual(["terminal"]);
    expect(u.dirsRw).toEqual(["{flmux_users}/u/{name}", "{flmux_users}/shared_rw"]);
  });

  it("explicit dirs_rw + fs_unconfined override preset", () => {
    const u = storeWith(
      `[[users]]\nname="o"\nrole="user"\nhandle="h4"\nfs_unconfined=true\ndirs_rw=["{flmux_users}/shared_rw"]\n`
    ).getUser("o")!;
    expect(u.fsUnconfined).toBe(true);
    expect(u.dirsRw).toEqual(["{flmux_users}/shared_rw"]);
  });

  it("unknown role without allow_pane_kinds → throws", () => {
    expect(() => storeWith(`[[users]]\nname="z"\nrole="ghost"\n`).getUser("z")).toThrow(/dev\|tech\|user/);
  });

  it("invalid handle charset → throws", () => {
    expect(() => storeWith(`[[users]]\nname="b"\nrole="user"\nhandle="../etc"\n`).getUser("b")).toThrow(/invalid handle/);
  });

  it("duplicate handle → throws", () => {
    const toml = `[[users]]\nname="a"\nrole="user"\nhandle="dup"\n\n[[users]]\nname="b"\nrole="user"\nhandle="dup"\n`;
    expect(() => storeWith(toml).listUsers()).toThrow(/duplicate handle/);
  });
});
