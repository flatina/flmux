import { describe, expect, it } from "bun:test";
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
});
