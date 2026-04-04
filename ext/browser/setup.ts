import type { ExtensionSetup } from "flmux-sdk";

export default {
  onInit(ctx) {
    const disposable = ctx.registerPaneSource({
      id: "browser",
      icon: "\u{1F310}",
      label: "Browser",
      order: 10,
      defaultPlacement: undefined,
      createLeaf() {
        return { kind: "browser" };
      }
    });

    return {
      [Symbol.dispose]() {
        disposable[Symbol.dispose]();
      }
    };
  }
} satisfies ExtensionSetup;
