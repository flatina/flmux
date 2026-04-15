import { definePane } from "@flmux/extension-api";
import { InspectorPaneRenderer } from "./inspectorPane";
import { createExternalPaneDescriptor } from "./runtime";

export const inspectorPaneDescriptor = createExternalPaneDescriptor({
  ...definePane({
    kind: "inspector",
    mount: (host, context) => new InspectorPaneRenderer(host, context),
    createParams: ({ input }) => ({
      subscription: typeof input.params?.subscription === "string" && input.params.subscription.length > 0
        ? input.params.subscription
        : "*"
    }),
    getTitle: ({ input }) => input.title?.trim() || "Inspector",
    normalizeRestoredParams: ({ params }) => ({
      subscription: typeof params?.subscription === "string" && params.subscription.length > 0
        ? params.subscription
        : "*"
    }),
    serializeParams: ({ currentParams }) => ({
      subscription: typeof currentParams?.subscription === "string" && currentParams.subscription.length > 0
        ? currentParams.subscription
        : "*"
    }),
    pathMount: {
      mountKey: "inspector",
      getStateSnapshot: ({ currentParams }) => ({
        subscription: typeof currentParams?.subscription === "string" && currentParams.subscription.length > 0
          ? currentParams.subscription
          : "*"
      }),
      getStatusSnapshot: ({ workspaceId, rootDir, defaultFixture }) => ({
        workspaceId,
        rootDir,
        defaultFixture
      })
    }
  })
});
