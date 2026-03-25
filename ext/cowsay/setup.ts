import type { ExtensionSetup } from "../../src/shared/extension-spi";

export default {
  onInit(ctx) {
    const tab = ctx.registerWorkspaceTab({
      id: "cowsay",
      title: "Cowsay Lab",
      singleton: true,
      titlebar: {
        icon: "\u{1F42E}",
        tooltip: "Open Cowsay Workspace Tab",
        order: 50
      }
    });

    const paneAction = ctx.registerGroupAction({
      id: "moo",
      icon: "\u{1F42E}",
      tooltip: "Open Cowsay Pane",
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
        paneAction[Symbol.dispose]();
        hide[Symbol.dispose]();
      }
    };
  }
} satisfies ExtensionSetup;
