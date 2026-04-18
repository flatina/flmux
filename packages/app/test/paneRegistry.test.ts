import { describe, expect, it } from "bun:test";
import { registerBuiltinPaneDescriptors } from "../src/renderer/shell/builtinPaneDescriptors";
import { PaneRegistry, type PaneDescriptor } from "../src/renderer/shell/paneRegistry";
import { makePaneWorkspaceContext } from "./support/paneWorkspaceContext";

const APP_ORIGIN = "http://127.0.0.1:4321";

function createDescriptor(kind: string): PaneDescriptor {
  return {
    kind,
    createRenderer: () => ({}) as never
  };
}

function registerBuiltinDesktopDescriptors(registry: PaneRegistry) {
  registerBuiltinPaneDescriptors(registry, {
    installRoot: "C:\\workspace",
    resolveTerminalCwd(_rootDir, inputCwd) {
      return inputCwd ?? "C:\\workspace";
    }
  });
}

describe("pane registry", () => {
  it("rejects duplicate descriptor kinds", () => {
    const registry = new PaneRegistry();
    registry.register(createDescriptor("browser"));
    expect(() => registry.register(createDescriptor("browser"))).toThrow(
      "Pane descriptor 'browser' is already registered"
    );
  });

  it("prefixes app origin on restored root-relative browser urls", () => {
    const registry = new PaneRegistry();
    registerBuiltinDesktopDescriptors(registry);

    const browser = registry.get("browser");
    expect(
      browser?.persistence?.normalizeRestoredParams?.({
        workspace: makePaneWorkspaceContext({ appOrigin: APP_ORIGIN }),
        params: {
          url: "/__flmux/internal/start?workspace=workspace.beta"
        }
      })
    ).toEqual({
      url: `${APP_ORIGIN}/__flmux/internal/start?workspace=workspace.beta`
    });
  });

  it("preserves explicit cross-origin urls for new browser panes", () => {
    const registry = new PaneRegistry();
    registerBuiltinDesktopDescriptors(registry);

    const browser = registry.get("browser");
    expect(
      browser?.lifecycle?.createParams?.({
        workspace: makePaneWorkspaceContext({ appOrigin: APP_ORIGIN }),
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
    registerBuiltinDesktopDescriptors(registry);

    const browser = registry.get("browser");
    expect(
      browser?.persistence?.normalizeRestoredParams?.({
        workspace: makePaneWorkspaceContext({ appOrigin: APP_ORIGIN }),
        params: {
          url: "https://example.com/fixtures/report"
        }
      })
    ).toEqual({
      url: "https://example.com/fixtures/report"
    });
  });

  it("strips app origin from serialized same-origin browser urls", () => {
    const registry = new PaneRegistry();
    registerBuiltinDesktopDescriptors(registry);

    const browser = registry.get("browser");
    expect(
      browser?.persistence?.serializeParams?.({
        workspace: makePaneWorkspaceContext({ appOrigin: APP_ORIGIN }),
        record: { kind: "browser", url: `${APP_ORIGIN}/dashboard?q=x` },
        currentParams: undefined
      })
    ).toEqual({
      url: "/dashboard?q=x"
    });
  });
});
