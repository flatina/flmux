import { describe, expect, test } from "bun:test";
import type { PropertyHandle } from "../../../types/property";
import type { ExtensionSetupModule } from "../../model/bootstrap-state";
import { ExtensionSetupRegistry } from "./extension-setup-registry";

function makeExtension(id: string, source: string): ExtensionSetupModule {
  return {
    id,
    source
  };
}

function makeStubApp(): PropertyHandle {
  const store: Record<string, unknown> = { title: "flmux" };
  return {
    get: (key: string) => store[key],
    set: (key: string, value: unknown) => { store[key] = value; },
    list: () => ({ ...store }),
    schema: () => ({})
  };
}

describe("ExtensionSetupRegistry titlebar workspace tabs", () => {
  test("lists only workspace tabs with titlebar metadata and sorts by order", async () => {
    const registry = new ExtensionSetupRegistry();
    try {
      await registry.loadAll([
        makeExtension(
          "sample.three",
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
      ], makeStubApp());

      const launchers = registry.listTitlebarWorkspaceTabs();
      expect(launchers.map((launcher) => launcher.qualifiedId)).toEqual(["sample.two:alpha", "sample.three:beta"]);
      expect(launchers.map((launcher) => launcher.titlebar?.icon)).toEqual(["A", "B"]);
      expect(launchers[0]?.titlebar?.tooltip).toBe("Open Alpha");
      expect(launchers.every((launcher) => !!launcher.titlebar)).toBe(true);
    } finally {
      registry[Symbol.dispose]();
    }
  });

  test("resolves built-in and extension launchers through one ordered list", async () => {
    const registry = new ExtensionSetupRegistry();
    try {
      await registry.loadAll([
        makeExtension(
          "sample.one",
          `
          export default {
            onInit(ctx) {
              ctx.registerWorkspaceTab({
                id: "beta",
                title: "Beta",
                titlebar: { icon: "B", order: 20, tooltip: "Open Beta" }
              });
            }
          };
        `
        )
      ], makeStubApp());

      const launchers = registry.resolveTitlebarLaunchers([
        {
          id: "builtin:terminal",
          icon: ">_",
          tooltip: "New Terminal Tab",
          order: 10,
          run() {}
        }
      ]);

      expect(launchers.map((launcher) => launcher.id)).toEqual(["builtin:terminal", "sample.one:beta"]);
      expect(launchers.map((launcher) => launcher.tooltip)).toEqual(["New Terminal Tab", "Open Beta"]);
    } finally {
      registry[Symbol.dispose]();
    }
  });
});

describe("ExtensionSetupRegistry pane sources", () => {
  test("merges built-in and extension pane sources by order", async () => {
    const registry = new ExtensionSetupRegistry();
    try {
      await registry.loadAll([
        makeExtension(
          "sample.cowsay",
          `
          export default {
            onInit(ctx) {
              ctx.registerPaneSource({
                id: "cowsay",
                icon: "🐮",
                label: "Open Cowsay Pane",
                order: 15,
                createLeaf() {
                  return { kind: "view", viewKey: "sample.cowsay:cowsay" };
                },
                options: { singleton: true }
              });
            }
          };
        `
        )
      ], makeStubApp());

      const sources = registry.resolvePaneSources([
        {
          id: "editor",
          icon: "📄",
          label: "Add Editor",
          order: 10,
          createLeaf() {
            return { kind: "editor" };
          }
        }
      ]);

      expect(sources.map((source) => source.qualifiedId)).toEqual(["editor", "sample.cowsay:cowsay"]);
      expect(sources[1]?.options?.singleton).toBe(true);
    } finally {
      registry[Symbol.dispose]();
    }
  });
});

describe("ExtensionSetupRegistry app handle", () => {
  test("extensions can set app properties via setup context", async () => {
    const registry = new ExtensionSetupRegistry();
    const app = makeStubApp();
    try {
      await registry.loadAll([
        makeExtension(
          "sample.title",
          `
          export default {
            onInit(ctx) {
              ctx.app.set("title", "Custom Title");
              return { [Symbol.dispose]() {} };
            }
          };
        `
        )
      ], app);

      expect(app.get("title")).toBe("Custom Title");
    } finally {
      registry[Symbol.dispose]();
    }
  });
});
