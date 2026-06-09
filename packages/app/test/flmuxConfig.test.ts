// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${...}` template strings asserted as config values
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFlmuxBootConfig } from "../src/main/flmuxConfig";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function appToml(content: string): string {
  const root = mkdtempSync(join(tmpdir(), "flmux-config-"));
  tempRoots.push(root);
  const file = join(root, "app.toml");
  writeFileSync(file, content);
  return file;
}

function load(opts: { appConfigFile?: string | null; env?: Record<string, string>; argv?: string[] }) {
  return loadFlmuxBootConfig({
    appConfigFile: opts.appConfigFile ?? null,
    env: opts.env ?? {},
    argv: opts.argv ?? []
  });
}

describe("loadFlmuxBootConfig", () => {
  it("defaults when nothing is configured", async () => {
    const cfg = await load({});
    expect(cfg.server.port).toBeUndefined();
    expect(cfg.server.portSource).toBe("default");
    expect(cfg.server.rateLimit).toEqual({ max: 600, windowMs: 60_000 });
    expect(cfg.server.ws).toEqual({ pingIntervalMs: 25_000, idleTimeoutSeconds: 120 });
    expect(cfg.limits).toEqual({
      maxSessionsPerUser: 25,
      maxPanesPerUser: 200,
      maxTerminalsPerUser: 50,
      maxUploadBytes: undefined
    });
    expect(cfg.grace).toEqual({ clientMs: undefined, authorityEvictionMs: undefined });
    expect(cfg.app.name).toBeUndefined();
  });

  it("port priority: cli > env > config, with source label", async () => {
    const file = appToml(`[server]\nport = 5000\n`);
    expect((await load({ appConfigFile: file })).server).toMatchObject({ port: 5000, portSource: "config" });
    expect((await load({ appConfigFile: file, env: { FLMUX_PORT: "6000" } })).server).toMatchObject({
      port: 6000,
      portSource: "env"
    });
    // Both `--port 7000` and `--port=7000` forms.
    expect(
      (await load({ appConfigFile: file, env: { FLMUX_PORT: "6000" }, argv: ["bun", "main.ts", "--port", "7000"] }))
        .server
    ).toMatchObject({ port: 7000, portSource: "cli" });
    expect((await load({ argv: ["bun", "main.ts", "--port=7000"] })).server).toMatchObject({
      port: 7000,
      portSource: "cli"
    });
  });

  it("port 0 is valid (OS-assigned); invalid port fails the boot", async () => {
    expect((await load({ argv: ["--port", "0"] })).server.port).toBe(0);
    await expect(load({ env: { FLMUX_PORT: "abc" } })).rejects.toThrow(/invalid port/);
    await expect(load({ env: { FLMUX_PORT: "70000" } })).rejects.toThrow(/invalid port/);
  });

  it("app display strings from app.toml; defaults + blank handling", async () => {
    const file = appToml(`[app]\nname = "Acme"\nwatermarkHeader = "  "\nappTitle = "\${appName}"\n`);
    const cfg = await load({ appConfigFile: file });
    expect(cfg.app.name).toBe("Acme");
    expect(cfg.app.appTitle).toBe("${appName}"); // explicit override
    expect(cfg.app.watermarkHeader).toBeUndefined(); // blank → undefined (hidden)
    expect(cfg.app.watermarkFooter).toBe("${appName} v${appVersion}"); // unset → default template
  });

  it("appTitle/watermarkFooter default to the version template when unset", async () => {
    const cfg = await load({ appConfigFile: appToml(`[app]\nname = "Acme"\n`) });
    expect(cfg.app.appTitle).toBe("${appName} v${appVersion}");
    expect(cfg.app.watermarkFooter).toBe("${appName} v${appVersion}");
  });

  it("tolerates a missing config file", async () => {
    const cfg = await load({ appConfigFile: join(tmpdir(), "no-such-dir", "app.toml") });
    expect(cfg.server.portSource).toBe("default");
  });

  it("numeric env knobs: empty → default, zero/garbage throw", async () => {
    const cfg = await load({ env: { FLMUX_RATELIMIT_MAX: "900", FLMUX_MAX_SESSIONS_PER_USER: "" } });
    expect(cfg.server.rateLimit.max).toBe(900);
    expect(cfg.limits.maxSessionsPerUser).toBe(25);
    await expect(load({ env: { FLMUX_RATELIMIT_MAX: "lots" } })).rejects.toThrow(/FLMUX_RATELIMIT_MAX/);
    await expect(load({ env: { FLMUX_MAX_SESSIONS_PER_USER: "0" } })).rejects.toThrow(/FLMUX_MAX_SESSIONS_PER_USER/);
  });

  it("unknown app.toml keys are ignored (dev is a mode flag, not config)", async () => {
    const file = appToml(`dev = true\n[app]\nname = "x"\n`);
    const cfg = await load({ appConfigFile: file });
    expect((cfg as unknown as Record<string, unknown>).dev).toBeUndefined();
    expect(cfg.app.name).toBe("x");
  });

  it("whitespace-padded numeric env values are accepted", async () => {
    const cfg = await load({ env: { FLMUX_RATELIMIT_MAX: " 900 ", FLMUX_PORT: " 8080 " } });
    expect(cfg.server.rateLimit.max).toBe(900);
    expect(cfg.server.port).toBe(8080);
    await expect(load({ env: { FLMUX_CLIENT_GRACE_MS: "100x" } })).rejects.toThrow(/FLMUX_CLIENT_GRACE_MS/);
  });

  it("unmapped env and argv are ignored", async () => {
    const cfg = await load({
      env: { FLMUX_UNRELATED: "x", PATH: "y" },
      argv: ["--dev-auth-as=admin", "--web"]
    });
    expect(cfg.server.portSource).toBe("default");
    expect((cfg as unknown as Record<string, unknown>)["dev-auth-as"]).toBeUndefined();
    expect((cfg as unknown as Record<string, unknown>).web).toBeUndefined();
  });

  it("grace values pass through; publicOrigin/trustedProxies strings", async () => {
    const cfg = await load({
      env: {
        FLMUX_CLIENT_GRACE_MS: "500",
        FLMUX_AUTHORITY_EVICTION_GRACE_MS: "1000",
        FLMUX_PUBLIC_ORIGIN: "https://x.ts.net",
        FLMUX_TRUSTED_PROXIES: "10.0.0.1, 10.0.0.2"
      }
    });
    expect(cfg.grace).toEqual({ clientMs: 500, authorityEvictionMs: 1000 });
    expect(cfg.server.publicOrigin).toBe("https://x.ts.net");
    expect(cfg.server.trustedProxies).toBe("10.0.0.1, 10.0.0.2");
  });
});
