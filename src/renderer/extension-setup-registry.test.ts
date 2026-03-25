import { describe, expect, test } from "bun:test";
import type { ExtensionRegistryEntry } from "../shared/extension-spi";
import { ExtensionSetupRegistry } from "./extension-setup-registry";

function makeExtension(id: string, setupSource: string): ExtensionRegistryEntry {
  return {
    id,
    name: id,
    version: "0.0.0",
    embedded: true,
    contributions: {
      panels: [],
      events: []
    },
    permissions: [],
    setupSource
  };
}

describe("ExtensionSetupRegistry titlebar workspace tabs", () => {
  test("lists only workspace tabs with titlebar metadata and sorts by order", async () => {
    const registry = new ExtensionSetupRegistry();
    try {
      await registry.loadAll([
        makeExtension(
          "sample.one",
          `
          export default {
            onInit(ctx) {
              ctx.registerWorkspaceTab({
                id: "hidden",
                title: "Hidden"
              });
              ctx.registerWorkspaceTab({
                id: "beta",
                title: "Beta",
                titlebar: { icon: "B", order: 20 }
              });
            }
          };
        `
        ),
        makeExtension(
          "sample.two",
          `
          export default {
            onInit(ctx) {
              ctx.registerWorkspaceTab({
                id: "alpha",
                title: "Alpha",
                titlebar: { icon: "A", order: 10, tooltip: "Open Alpha" }
              });
            }
          };
        `
        )
      ]);

      const launchers = registry.listTitlebarWorkspaceTabs();
      expect(launchers.map((launcher) => launcher.qualifiedId)).toEqual(["sample.two:alpha", "sample.one:beta"]);
      expect(launchers.map((launcher) => launcher.titlebar?.icon)).toEqual(["A", "B"]);
      expect(launchers[0]?.titlebar?.tooltip).toBe("Open Alpha");
      expect(launchers.every((launcher) => !!launcher.titlebar)).toBe(true);
    } finally {
      registry[Symbol.dispose]();
    }
  });
});
