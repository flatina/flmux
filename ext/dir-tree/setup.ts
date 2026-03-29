import type { ExtensionSetup } from "flmux-sdk";

export default {
  onInit(ctx) {
    const disposable = ctx.registerPaneSource({
      id: "explorer",
      icon: "\u{1F4C1}",
      label: "Explorer",
      order: 10,
      defaultPlacement: "left",
      createLeaf() {
        return { kind: "explorer" };
      }
    });

    return {
      [Symbol.dispose]() {
        disposable[Symbol.dispose]();
      }
    };
  }
} satisfies ExtensionSetup;
