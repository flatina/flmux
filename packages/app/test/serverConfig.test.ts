import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveFlmuxServerPort } from "../src/main/auth/serverConfig";

describe("resolveFlmuxServerPort", () => {
  it("returns default when nothing is specified", () => {
    const result = resolveFlmuxServerPort({ argv: [], env: {}, authDir: null });
    expect(result).toEqual({ port: undefined, source: "default" });
  });

  it("prefers --port CLI flag over env + config", () => {
    const authDir = mkdtempSync(join(tmpdir(), "flmux-cfg-"));
    try {
      writeFileSync(resolve(authDir, "server.toml"), `[server]\nport = 5000\n`, "utf8");
      const result = resolveFlmuxServerPort({
        argv: ["--web", "--port", "4095"],
        env: { FLMUX_PORT: "6000" },
        authDir
      });
      expect(result).toEqual({ port: 4095, source: "cli" });
    } finally {
      rmSync(authDir, { recursive: true, force: true });
    }
  });

  it("falls through CLI → env → config → default", () => {
    const authDir = mkdtempSync(join(tmpdir(), "flmux-cfg-"));
    try {
      writeFileSync(resolve(authDir, "server.toml"), `[server]\nport = 5000\n`, "utf8");
      expect(resolveFlmuxServerPort({ argv: [], env: { FLMUX_PORT: "6000" }, authDir }))
        .toEqual({ port: 6000, source: "env" });
      expect(resolveFlmuxServerPort({ argv: [], env: {}, authDir }))
        .toEqual({ port: 5000, source: "config" });
      expect(resolveFlmuxServerPort({ argv: [], env: {}, authDir: null }))
        .toEqual({ port: undefined, source: "default" });
    } finally {
      rmSync(authDir, { recursive: true, force: true });
    }
  });

  it("rejects malformed values (non-integer, out-of-range) and keeps falling through", () => {
    const authDir = mkdtempSync(join(tmpdir(), "flmux-cfg-"));
    try {
      writeFileSync(resolve(authDir, "server.toml"), `[server]\nport = 4095\n`, "utf8");
      // Bad CLI → falls through to env
      expect(resolveFlmuxServerPort({
        argv: ["--port", "not-a-number"],
        env: { FLMUX_PORT: "7000" },
        authDir
      })).toEqual({ port: 7000, source: "env" });
      // Bad env (out-of-range) → falls through to config
      expect(resolveFlmuxServerPort({
        argv: [],
        env: { FLMUX_PORT: "99999" },
        authDir
      })).toEqual({ port: 4095, source: "config" });
      // Bad config (negative) → falls through to default
      writeFileSync(resolve(authDir, "server.toml"), `[server]\nport = -1\n`, "utf8");
      expect(resolveFlmuxServerPort({ argv: [], env: {}, authDir }))
        .toEqual({ port: undefined, source: "default" });
    } finally {
      rmSync(authDir, { recursive: true, force: true });
    }
  });

  it("accepts port 0 from CLI (explicit OS-assign)", () => {
    expect(resolveFlmuxServerPort({ argv: ["--port", "0"], env: {}, authDir: null }))
      .toEqual({ port: 0, source: "cli" });
  });

  it("ignores missing server.toml silently", () => {
    const authDir = mkdtempSync(join(tmpdir(), "flmux-cfg-"));
    try {
      expect(resolveFlmuxServerPort({ argv: [], env: {}, authDir }))
        .toEqual({ port: undefined, source: "default" });
    } finally {
      rmSync(authDir, { recursive: true, force: true });
    }
  });
});
