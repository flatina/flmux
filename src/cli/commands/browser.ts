import { defineCommand } from "citty";
import { resolveBrowserPaneId, printJson, printPaneIds } from "../browser-utils";
import { getClient, sessionArg } from "./_utils";

const BROWSER_RPC_TIMEOUT_MS = 20_000;

export default defineCommand({
  meta: { name: "browser", description: "Manage flmux browser panes" },
  subCommands: {
    new: defineCommand({
      meta: { name: "new", description: "Create a new browser pane" },
      args: {
        ...sessionArg,
        json: { type: "boolean", description: "Print JSON output" },
        url: { type: "positional", description: "Initial URL" }
      },
      run: async ({ args }) => {
        const client = await getClient(args.session);
        const result = await client.call("browser.new", { url: args.url }, BROWSER_RPC_TIMEOUT_MS);
        if (args.json) {
          printJson(result);
          return;
        }
        console.log(result.paneId);
      }
    }),
    list: defineCommand({
      meta: { name: "list", description: "List browser panes" },
      args: {
        ...sessionArg,
        json: { type: "boolean", description: "Print JSON output" }
      },
      run: async ({ args }) => {
        const client = await getClient(args.session);
        const result = await client.call("browser.list", undefined, BROWSER_RPC_TIMEOUT_MS);
        if (args.json) {
          printJson(result);
          return;
        }
        printPaneIds(result.panes.map((pane) => String(pane.paneId)));
      }
    }),
    focus: defineCommand({
      meta: { name: "focus", description: "Focus a browser pane" },
      args: {
        ...sessionArg,
        json: { type: "boolean", description: "Print JSON output" },
        pane: { type: "string", description: "Browser pane ID" }
      },
      run: async ({ args }) => {
        const client = await getClient(args.session);
        const result = await client.call(
          "browser.focus",
          { paneId: resolveBrowserPaneId(args.pane) },
          BROWSER_RPC_TIMEOUT_MS
        );
        if (args.json) {
          printJson(result);
          return;
        }
        console.log(result.paneId);
      }
    }),
    close: defineCommand({
      meta: { name: "close", description: "Close a browser pane" },
      args: {
        ...sessionArg,
        json: { type: "boolean", description: "Print JSON output" },
        pane: { type: "string", description: "Browser pane ID" }
      },
      run: async ({ args }) => {
        const client = await getClient(args.session);
        const result = await client.call(
          "browser.close",
          { paneId: resolveBrowserPaneId(args.pane) },
          BROWSER_RPC_TIMEOUT_MS
        );
        if (args.json) {
          printJson(result);
          return;
        }
        console.log(result.paneId);
      }
    }),
    connect: defineCommand({
      meta: { name: "connect", description: "Validate that a browser pane is automation-ready" },
      args: {
        ...sessionArg,
        json: { type: "boolean", description: "Print JSON output" },
        pane: { type: "string", description: "Browser pane ID" }
      },
      run: async ({ args }) => {
        const client = await getClient(args.session);
        const result = await client.call(
          "browser.connect",
          { paneId: resolveBrowserPaneId(args.pane) },
          BROWSER_RPC_TIMEOUT_MS
        );
        if (args.json) {
          printJson(result);
          return;
        }
        if (!result.ok) {
          throw new Error(result.error);
        }
        console.log(result.paneId);
      }
    })
  }
});
