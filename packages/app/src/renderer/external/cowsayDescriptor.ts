import { definePane } from "@flmux/extension-api";
import { CowsayPaneRenderer } from "./cowsayPane";
import { createExternalPaneDescriptor } from "./runtime";

export const cowsayPaneDescriptor = createExternalPaneDescriptor({
  ...definePane({
    kind: "cowsay",
    mount: (host, context) => new CowsayPaneRenderer(host, context),
    getTitle: ({ input }) => input.title?.trim() || "Cowsay"
  })
});
