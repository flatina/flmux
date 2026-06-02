import { describe, expect, it } from "bun:test";
import { compileIgnore } from "../src/ignore";

describe("compileIgnore (.flmux-ext-ignore matcher)", () => {
  it("dir-only trailing slash matches a dir at any depth, not a same-name file", () => {
    const m = compileIgnore("vendor/\n");
    expect(m("vendor", true)).toBe(true);
    expect(m("src/vendor", true)).toBe(true);
    expect(m("vendor", false)).toBe(false); // a file named "vendor" is kept
  });

  it("bare name matches file or dir at any depth", () => {
    const m = compileIgnore("notes.md\n");
    expect(m("notes.md", false)).toBe(true);
    expect(m("docs/notes.md", false)).toBe(true);
    expect(m("notes.mdx", false)).toBe(false);
  });

  it("extension glob matches at any depth", () => {
    const m = compileIgnore("*.log\n");
    expect(m("a.log", false)).toBe(true);
    expect(m("src/deep/b.log", false)).toBe(true);
    expect(m("a.logger", false)).toBe(false);
  });

  it("leading slash anchors to root", () => {
    const m = compileIgnore("/scratch\n");
    expect(m("scratch", true)).toBe(true);
    expect(m("src/scratch", true)).toBe(false); // not anchored at root
  });

  it("** matches across segments", () => {
    const m = compileIgnore("**/tmp\n");
    expect(m("tmp", true)).toBe(true);
    expect(m("a/b/tmp", true)).toBe(true);
  });

  it("negation re-includes (last match wins)", () => {
    const m = compileIgnore("*.bin\n!keep.bin\n");
    expect(m("x.bin", false)).toBe(true);
    expect(m("keep.bin", false)).toBe(false);
  });

  it("ignores comments and blank lines; empty file excludes nothing", () => {
    const m = compileIgnore("# a comment\n\n   \n");
    expect(m("anything", false)).toBe(false);
    expect(m("vendor", true)).toBe(false);
  });

  it("does not match a longer sibling name (prefix safety)", () => {
    const m = compileIgnore("foo\n");
    expect(m("foo", false)).toBe(true);
    expect(m("foobar", false)).toBe(false);
  });

  it("normalizes native (backslash) separators", () => {
    const m = compileIgnore("src/_wasm/\n");
    expect(m("src\\_wasm", true)).toBe(true);
  });
});
