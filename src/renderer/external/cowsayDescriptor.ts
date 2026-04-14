import { CowsayPaneRenderer } from "./cowsayPane";
import { createExternalPaneDescriptor } from "./runtime";

export const cowsayPaneDescriptor = createExternalPaneDescriptor({
  kind: "cowsay",
  createRenderer: (context) => new CowsayPaneRenderer(context),
  getTitle: ({ input }) => input.title?.trim() || "Cowsay"
});
