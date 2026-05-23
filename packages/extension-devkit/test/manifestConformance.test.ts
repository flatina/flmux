import { describe, expect, it } from "bun:test";
import {
  validateExtensionManifest as validateApi,
  FLMUX_EXTENSION_API_VERSION as API_VERSION_API
} from "../../extension-api/src/manifest";
import {
  validateExtensionManifest as validateDevkit,
  FLMUX_EXTENSION_API_VERSION as API_VERSION_DEVKIT
} from "../src/manifest";

// The devkit validator is duplicated (no build-time dep on extension-api).
// This conformance suite runs a shared fixture set through both modules
// and asserts they return equal results — the only practical guard against
// silent drift between the two implementations.

interface Fixture {
  name: string;
  input: unknown;
}

const apiVersion = API_VERSION_API;

const fixtures: Fixture[] = [
  { name: "minimal renderer-only", input: makeBase({ entrypoints: { renderer: "./index.ts" } }) },
  { name: "cli with commands", input: makeBase({ entrypoints: { cli: "./cli.ts" }, commands: [{ id: "do" }] }) },
  {
    name: "cli with command shim and description",
    input: makeBase({
      entrypoints: { cli: "./cli.ts" },
      commands: [{ id: "do", description: "Do thing", shim: "do" }]
    })
  },
  { name: "server-only", input: makeBase({ entrypoints: { server: "./server.ts" } }) },
  {
    name: "panes — full triplet",
    input: makeBase({
      entrypoints: { renderer: "./index.ts" },
      panes: [{ kind: "alpha", defaultTitle: "Alpha", singletonScope: "workspace", icon: "./icon.svg" }]
    })
  },
  {
    name: "panes — singletonScope app",
    input: makeBase({
      entrypoints: { renderer: "./index.ts" },
      panes: [{ kind: "alpha", singletonScope: "app" }]
    })
  },
  {
    name: "panes — edgeGroup left",
    input: makeBase({
      entrypoints: { renderer: "./index.ts" },
      panes: [{ kind: "alpha", edgeGroup: "left" }]
    })
  },
  { name: "not-an-object", input: 42 },
  { name: "missing all fields", input: {} },
  { name: "wrong apiVersion", input: makeBase({ apiVersion: 999, entrypoints: { renderer: "./index.ts" } }) },
  { name: "no entrypoints", input: makeBase({ entrypoints: {} }) },
  { name: "renderer escapes dir", input: makeBase({ entrypoints: { renderer: "../escape.ts" } }) },
  { name: "absolute renderer", input: makeBase({ entrypoints: { renderer: "/abs.ts" } }) },
  { name: "windows-drive renderer", input: makeBase({ entrypoints: { renderer: "C:/x.ts" } }) },
  {
    name: "id with bad chars",
    input: makeBase({ id: "bad/id", entrypoints: { renderer: "./index.ts" } })
  },
  {
    name: "cli without commands",
    input: makeBase({ entrypoints: { cli: "./cli.ts" } })
  },
  {
    name: "commands without cli",
    input: makeBase({ entrypoints: { renderer: "./index.ts" }, commands: [{ id: "do" }] })
  },
  {
    name: "duplicate command id",
    input: makeBase({ entrypoints: { cli: "./cli.ts" }, commands: [{ id: "do" }, { id: "do" }] })
  },
  {
    name: "command shim empty",
    input: makeBase({ entrypoints: { cli: "./cli.ts" }, commands: [{ id: "do", shim: "  " }] })
  },
  {
    name: "panes empty array",
    input: makeBase({ entrypoints: { renderer: "./index.ts" }, panes: [] })
  },
  {
    name: "duplicate pane kind",
    input: makeBase({
      entrypoints: { renderer: "./index.ts" },
      panes: [{ kind: "a" }, { kind: "a" }]
    })
  },
  {
    name: "pane singletonScope invalid",
    input: makeBase({
      entrypoints: { renderer: "./index.ts" },
      panes: [{ kind: "a", singletonScope: "global" }]
    })
  },
  {
    name: "pane edgeGroup invalid",
    input: makeBase({
      entrypoints: { renderer: "./index.ts" },
      panes: [{ kind: "a", edgeGroup: "center" }]
    })
  },
  {
    name: "pane defaultTitle empty",
    input: makeBase({
      entrypoints: { renderer: "./index.ts" },
      panes: [{ kind: "a", defaultTitle: "  " }]
    })
  },
  {
    name: "pane icon escapes dir",
    input: makeBase({
      entrypoints: { renderer: "./index.ts" },
      panes: [{ kind: "a", icon: "../icon.svg" }]
    })
  }
];

function makeBase(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "sample.ext",
    name: "Sample",
    version: "0.1.0",
    apiVersion,
    ...overrides
  };
}

describe("manifest validator conformance: extension-api vs extension-devkit", () => {
  it("ships the same FLMUX_EXTENSION_API_VERSION", () => {
    expect(API_VERSION_DEVKIT).toBe(API_VERSION_API);
  });

  for (const fixture of fixtures) {
    it(fixture.name, () => {
      const apiResult = validateApi(fixture.input);
      const devkitResult = validateDevkit(fixture.input);
      expect(devkitResult).toEqual(apiResult);
    });
  }
});
