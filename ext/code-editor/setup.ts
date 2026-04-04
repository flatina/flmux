import type { ExtensionSetup } from "flmux-sdk";

export default {
  onInit(ctx) {
    const disposable = ctx.registerPaneSource({
      id: "editor",
      icon: "\u{1F4C4}",
      label: "Editor",
      order: 40,
      defaultPlacement: undefined,
      createLeaf() {
        return { kind: "editor" };
      }
    });

    return {
      [Symbol.dispose]() {
        disposable[Symbol.dispose]();
      }
    };
  }
} satisfies ExtensionSetup;
