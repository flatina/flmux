import { describe, expect, test } from "bun:test";
import { parseStartupOrphanPtydPolicy, resolveStartupOrphanPtydPolicy } from "./ptyd-recovery";

describe("parseStartupOrphanPtydPolicy", () => {
  test("accepts valid values", () => {
    expect(parseStartupOrphanPtydPolicy("ask")).toBe("ask");
    expect(parseStartupOrphanPtydPolicy("recover")).toBe("recover");
    expect(parseStartupOrphanPtydPolicy("reset")).toBe("reset");
    expect(parseStartupOrphanPtydPolicy("exit")).toBe("exit");
  });

  test("normalizes case and whitespace", () => {
    expect(parseStartupOrphanPtydPolicy(" Recover ")).toBe("recover");
  });

  test("rejects unknown values", () => {
    expect(parseStartupOrphanPtydPolicy("foo")).toBeNull();
    expect(parseStartupOrphanPtydPolicy(undefined)).toBeNull();
  });
});

describe("resolveStartupOrphanPtydPolicy", () => {
  test("defaults to ask", () => {
    expect(resolveStartupOrphanPtydPolicy(["flmux"], {})).toBe("ask");
  });

  test("reads inline cli argument", () => {
    expect(resolveStartupOrphanPtydPolicy(["flmux", "--orphan-ptyd=exit"], {})).toBe("exit");
  });

  test("reads split cli argument", () => {
    expect(resolveStartupOrphanPtydPolicy(["flmux", "--orphan-ptyd", "recover"], {})).toBe("recover");
  });

  test("cli argument wins over env", () => {
    expect(resolveStartupOrphanPtydPolicy(["flmux", "--orphan-ptyd=reset"], { FLMUX_ORPHAN_PTYD: "exit" })).toBe("reset");
  });

  test("uses env when cli is absent", () => {
    expect(resolveStartupOrphanPtydPolicy(["flmux"], { FLMUX_ORPHAN_PTYD: "exit" })).toBe("exit");
  });
});
