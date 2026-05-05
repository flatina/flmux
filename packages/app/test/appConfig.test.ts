import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveFlmuxAppTitle } from "../src/main/appConfig";

describe("resolveFlmuxAppTitle", () => {
  it("returns undefined when configFile is missing or null", () => {
    expect(resolveFlmuxAppTitle(null)).toBeUndefined();
    expect(resolveFlmuxAppTitle(undefined)).toBeUndefined();
    expect(resolveFlmuxAppTitle("/no/such/path/app.toml")).toBeUndefined();
  });

  it("reads [app] title", () => {
    const dir = mkdtempSync(join(tmpdir(), "flmux-app-cfg-"));
    try {
      const configFile = resolve(dir, "app.toml");
      writeFileSync(configFile, '[app]\ntitle = "My Flmux"\n', "utf8");
      expect(resolveFlmuxAppTitle(configFile)).toBe("My Flmux");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for empty/whitespace title", () => {
    const dir = mkdtempSync(join(tmpdir(), "flmux-app-cfg-"));
    try {
      const configFile = resolve(dir, "app.toml");
      writeFileSync(configFile, '[app]\ntitle = "   "\n', "utf8");
      expect(resolveFlmuxAppTitle(configFile)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when [app] section absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "flmux-app-cfg-"));
    try {
      const configFile = resolve(dir, "app.toml");
      writeFileSync(configFile, "[server]\nport = 7777\n", "utf8");
      expect(resolveFlmuxAppTitle(configFile)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
