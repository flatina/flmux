import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { resolveAppPtydEntry } from "../src/main/ptyd/launch";

const BASE_DIR = "C:\\project\\packages\\app\\src\\main\\ptyd";
const BUN = "bun";

describe("app ptyd launch resolution", () => {
  it("prefers the source daemon entry when it exists", () => {
    const sourceEntrypoint = resolve(BASE_DIR, "daemonMain.ts");
    const launch = resolveAppPtydEntry(BASE_DIR, (path) => path === sourceEntrypoint, BUN);

    expect(launch).toEqual({
      command: BUN,
      args: [sourceEntrypoint],
      cwd: BASE_DIR
    });
  });

  it("falls back to packages/app dist before repo dist", () => {
    const appDistEntrypoint = resolve(BASE_DIR, "../../../dist/ptyd.js");
    const launch = resolveAppPtydEntry(BASE_DIR, (path) => path === appDistEntrypoint, BUN);

    expect(launch).toEqual({
      command: BUN,
      args: [appDistEntrypoint],
      cwd: resolve(BASE_DIR, "../../../dist")
    });
  });

  it("resolves repo-level dist fallback from the actual repo root", () => {
    const launch = resolveAppPtydEntry(BASE_DIR, () => false, BUN);

    expect(launch).toEqual({
      command: BUN,
      args: [resolve(BASE_DIR, "../../../../../dist/ptyd.js")],
      cwd: resolve(BASE_DIR, "../../../../../dist")
    });
  });
});
