import { describe, expect, it } from "bun:test";
import { registerBuiltinPaneDescriptors } from "../src/renderer/shell/builtinPaneDescriptors";
import { PaneRegistry, type PaneDescriptor } from "../src/renderer/shell/paneRegistry";

function createDescriptor(kind: string): PaneDescriptor {
  return {
    kind,
    createRenderer: () => ({}) as never
  };
}

describe("pane registry", () => {
  it("rejects duplicate descriptor kinds", () => {
    const registry = new PaneRegistry();

    registry.register(createDescriptor("browser"));

    expect(() => registry.register(createDescriptor("browser"))).toThrow(
      "Pane descriptor 'browser' is already registered"
    );
  });

  it("preserves restored same-origin browser urls", () => {
    const registry = new PaneRegistry();
    registerBuiltinPaneDescriptors(registry, {
      installRoot: "C:\\workspace",
      requireBrowserUrl(value) {
        return value.startsWith("/")
          ? `http://127.0.0.1:4321${value}`
          : value;
      },
      resolveTerminalCwd(_rootDir, inputCwd) {
        return inputCwd ?? "C:\\workspace";
      },
      serializeBrowserUrl(url) {
        return url;
      }
    });

    const browser = registry.get("browser");
    expect(
      browser?.persistence?.normalizeRestoredParams?.({
        workspace: {
          id: "workspace.test",
          defaultBrowserPath: "/__flmux/internal/start?workspace=workspace.test",
          bus: {
            publish() {},
            subscribe() {
              return () => {};
            }
          },
          appOrigin: "http://localhost:0"
        },
        params: {
          url: "/__flmux/internal/start?workspace=workspace.beta"
        }
      })
    ).toEqual({
      url: "http://127.0.0.1:4321/__flmux/internal/start?workspace=workspace.beta"
    });
  });

  it("preserves explicit non-app fixture-looking urls for new browser panes", () => {
    const registry = new PaneRegistry();
    registerBuiltinPaneDescriptors(registry, {
      installRoot: "C:\\workspace",
      requireBrowserUrl(value) {
        return value.startsWith("/")
          ? `http://127.0.0.1:4321${value}`
          : value;
      },
      resolveTerminalCwd(_rootDir, inputCwd) {
        return inputCwd ?? "C:\\workspace";
      },
      serializeBrowserUrl(url) {
        return url;
      }
    });

    const browser = registry.get("browser");
    expect(
      browser?.lifecycle?.createParams?.({
        workspace: {
          id: "workspace.test",
          defaultBrowserPath: "/__flmux/internal/start?workspace=workspace.test",
          bus: {
            publish() {},
            subscribe() {
              return () => {};
            }
          },
          appOrigin: "http://localhost:0"
        },
        input: {
          kind: "browser",
          url: "https://example.com/fixtures/report"
        }
      })
    ).toEqual({
      url: "https://example.com/fixtures/report"
    });
  });

  it("preserves restored cross-origin fixture-looking urls", () => {
    const registry = new PaneRegistry();
    registerBuiltinPaneDescriptors(registry, {
      installRoot: "C:\\workspace",
      requireBrowserUrl(value) {
        return value.startsWith("/")
          ? `http://127.0.0.1:4321${value}`
          : value;
      },
      resolveTerminalCwd(_rootDir, inputCwd) {
        return inputCwd ?? "C:\\workspace";
      },
      serializeBrowserUrl(url) {
        return url;
      }
    });

    const browser = registry.get("browser");
    expect(
      browser?.persistence?.normalizeRestoredParams?.({
        workspace: {
          id: "workspace.test",
          defaultBrowserPath: "/__flmux/internal/start?workspace=workspace.test",
          bus: {
            publish() {},
            subscribe() {
              return () => {};
            }
          },
          appOrigin: "http://localhost:0"
        },
        params: {
          url: "https://example.com/fixtures/report"
        }
      })
    ).toEqual({
      url: "https://example.com/fixtures/report"
    });
  });
});
