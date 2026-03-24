import type { ExtensionSetup } from "../../src/shared/extension-abi";

export default {
  onInit(ctx) {
    // Register a singleton workspace tab for cowsay
    const tab = ctx.registerWorkspaceTab({
      id: "cowsay",
      title: "Cowsay",
      singleton: true
    });

    // Register 🐮 group action that opens cowsay as singleton pane
    const action = ctx.registerGroupAction({
      id: "moo",
      icon: "\u{1F42E}",
      tooltip: "Open Cowsay",
      order: 50,
      run(actionCtx) {
        actionCtx.openPane(
          { kind: "extension", extensionId: "sample.cowsay", contributionId: "cowsay" },
          undefined,
          { singleton: true }
        );
      }
    });

    const hide = ctx.onCreateGroupActions(() => {
      // actions.hide("browser", "explorer"); // example
    });

    return {
      [Symbol.dispose]() {
        tab[Symbol.dispose]();
        action[Symbol.dispose]();
        hide[Symbol.dispose]();
      }
    };
  }
} satisfies ExtensionSetup;
