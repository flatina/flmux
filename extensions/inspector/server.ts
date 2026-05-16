import { defineExtensionServer, definePaneSpec } from "@flmux/extension-api";
import { normalizeSubscription } from "./helpers";

export default defineExtensionServer({
  panes: [
    definePaneSpec({
      kind: "inspector",
      createParams: ({ input }) => ({ subscription: normalizeSubscription(input.params?.subscription) }),
      normalizeRestoredParams: ({ params }) => ({ subscription: normalizeSubscription(params?.subscription) }),
      serializeParams: ({ currentParams }) => ({ subscription: normalizeSubscription(currentParams?.subscription) }),
      pathMount: {
        mountKey: "inspector",
        getStateSnapshot: ({ currentParams }) => ({
          subscription: normalizeSubscription(currentParams?.subscription)
        }),
        getStatusSnapshot: ({ workspaceId, defaultBrowserPath }) => ({ workspaceId, defaultBrowserPath })
      }
    })
  ]
});
