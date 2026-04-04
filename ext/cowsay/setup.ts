import type { ExtensionSetup } from "flmux-sdk";

export default {
  onInit(ctx) {
    ctx.app.set("title", "app title by cowsay");

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

    const paneAction = ctx.registerPaneSource({
      id: "moo",
      icon: "\u{1F42E}",
      label: "Cowsay",
      order: 60,
      defaultPlacement: undefined,
      createLeaf() {
        return { kind: "view", viewKey: "sample.cowsay:cowsay", title: "Cowsay Lab" };
      },
      options: { singleton: true }
    });

    const hide = ctx.onResolveWorkspaceActions(() => {
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
