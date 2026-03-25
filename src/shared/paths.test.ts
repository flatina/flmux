import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sep } from "node:path";
import {
  getFlmuxConfigDir,
  getFlmuxDataDir,
  getFlmuxStateDir,
  getFlmuxLastPath,
  getSessionDir,
  getExtensionsDir,
  getBrowserCtlRefsPath
} from "./paths";

/** Join path segments with the platform separator */
function p(...parts: string[]): string {
  return parts.join(sep);
}

describe("XDG paths", () => {
  const saved: Record<string, string | undefined> = {};
  const vars = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"];

  beforeAll(() => {
    for (const v of vars) saved[v] = process.env[v];
  });

  beforeEach(() => {
    for (const v of vars) delete process.env[v];
  });

  afterAll(() => {
    for (const v of vars) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  test("respects XDG_CONFIG_HOME", () => {
    process.env.XDG_CONFIG_HOME = p("/tmp", "xdg-test", "config");
    expect(getFlmuxConfigDir()).toBe(p("/tmp", "xdg-test", "config", "flmux"));
  });

  test("respects XDG_DATA_HOME", () => {
    process.env.XDG_DATA_HOME = p("/tmp", "xdg-test", "data");
    expect(getFlmuxDataDir()).toBe(p("/tmp", "xdg-test", "data", "flmux"));
  });

  test("respects XDG_STATE_HOME", () => {
    process.env.XDG_STATE_HOME = p("/tmp", "xdg-test", "state");
    expect(getFlmuxStateDir()).toBe(p("/tmp", "xdg-test", "state", "flmux"));
  });

  test("concrete paths use correct base dirs", () => {
    process.env.XDG_STATE_HOME = p("/tmp", "xdg-test", "state");
    process.env.XDG_DATA_HOME = p("/tmp", "xdg-test", "data");

    expect(getFlmuxLastPath()).toBe(p("/tmp", "xdg-test", "state", "flmux", "flmux-last.json"));
    expect(getSessionDir()).toBe(p("/tmp", "xdg-test", "data", "flmux", "sessions"));
    expect(getExtensionsDir()).toBe(p("/tmp", "xdg-test", "data", "flmux", "extensions"));
    expect(getBrowserCtlRefsPath()).toBe(p("/tmp", "xdg-test", "data", "flmux", "browser-ctl-refs.json"));
  });

  test("falls back to HOME-based defaults when XDG vars unset", () => {
    expect(getFlmuxConfigDir()).toContain(".config");
    expect(getFlmuxConfigDir()).toEndWith(`${sep}flmux`);
    expect(getFlmuxDataDir()).toContain(p(".local", "share"));
    expect(getFlmuxDataDir()).toEndWith(`${sep}flmux`);
    expect(getFlmuxStateDir()).toContain(p(".local", "state"));
    expect(getFlmuxStateDir()).toEndWith(`${sep}flmux`);
  });

  test("empty string XDG var falls back to default", () => {
    process.env.XDG_CONFIG_HOME = "";
    process.env.XDG_DATA_HOME = "";
    process.env.XDG_STATE_HOME = "";

    expect(getFlmuxConfigDir()).toContain(".config");
    expect(getFlmuxDataDir()).toContain(p(".local", "share"));
    expect(getFlmuxStateDir()).toContain(p(".local", "state"));
  });
});
