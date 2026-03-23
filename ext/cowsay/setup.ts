import type { ExtensionSetup } from "../../src/shared/extension-abi";

export default {
  onInit(ctx) {
    const reg = ctx.registerGroupAction({
      id: "moo",
      icon: "\u{1F42E}",
      tooltip: "Open Cowsay",
      order: 50,
      run(actionCtx) {
        actionCtx.openPane({
          kind: "extension",
          extensionId: "sample.cowsay",
          contributionId: "cowsay"
        });
      }
    });

    const hide = ctx.onCreateGroupActions((actions) => {
      // actions.hide("browser", "explorer"); // example
    });

    return {
      [Symbol.dispose]() {
        reg[Symbol.dispose]();
        hide[Symbol.dispose]();
      }
    };
  }
} satisfies ExtensionSetup;
