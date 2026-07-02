import { describe, expect, it } from "bun:test";
import { createPreferenceReaders, type ShellClient } from "@flmux/extension-api";

const shell: ShellClient = {
  get: async (path) => {
    if (path === "/userpref/demo.ext")
      return { ok: true, found: true, value: { fields: [], values: { a: 1, b: "x" } } };
    if (path === "/userpref/demo.ext/a") return { ok: true, found: true, value: 1 };
    // Real backend shape for an unset key: mount exists (found:true), value coalesced to null.
    if (path === "/userpref/demo.ext/missing") return { ok: true, found: true, value: null };
    return { ok: false, code: "NOT_FOUND", error: "unexpected" };
  },
  list: async () => ({ ok: true, found: true, entries: [] }),
  set: async () => ({ ok: true, value: null }),
  call: async () => ({ ok: true, value: null })
};

describe("createPreferenceReaders", () => {
  const readers = createPreferenceReaders(shell, "demo.ext");

  it("getPreferences returns the values map; getPreference returns one value / undefined", async () => {
    expect(await readers.getPreferences()).toEqual({ a: 1, b: "x" });
    expect(await readers.getPreference("a")).toBe(1);
    expect(await readers.getPreference("missing")).toBeUndefined();
  });

  it("getPreferences returns {} when the extension has no prefs", async () => {
    const empty = createPreferenceReaders(shell, "other.ext");
    expect(await empty.getPreferences()).toEqual({});
  });
});
