import type { ExtensionSetup } from "flmux-sdk";

export default {
  onInit(ctx) {
    const workspaceTab = ctx.registerWorkspaceTab({
      id: "inspector",
      title: "Properties",
      singleton: true,
      titlebar: {
        icon: "{}",
        tooltip: "Open Property Inspector",
        order: 45
      }
    });

    const paneSource = ctx.registerPaneSource({
      id: "properties",
      icon: "{}",
      label: "Properties",
      order: 50,
      defaultPlacement: undefined,
      createLeaf() {
        return {
          kind: "view",
          viewKey: "property-inspector:inspector",
          title: "Properties"
        };
      },
      options: { singleton: true }
    });

    return {
      [Symbol.dispose]() {
        workspaceTab[Symbol.dispose]();
        paneSource[Symbol.dispose]();
      }
    };
  }
} satisfies ExtensionSetup;
