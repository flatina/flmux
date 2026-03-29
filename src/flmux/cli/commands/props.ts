import { defineCommand } from "citty";
import { asPaneId, asTabId } from "../../../lib/ids";
import { subscribePropertyChanges } from "../../client/rpc-client";
import { getClient, output, sessionArg } from "./_utils";

export default defineCommand({
  meta: { name: "props", description: "Inspect and edit properties" },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List properties for a scope" },
      args: {
        ...sessionArg,
        scope: { type: "positional", required: true, description: "Scope: app | workspace | pane" },
        target: { type: "positional", description: "Target id for workspace/pane scopes" }
      },
      run: async ({ args }) => {
        const client = await getClient(args.session);
        output(await client.call("props.list", buildPropertyRequest(args.scope, args.target)));
      }
    }),
    get: defineCommand({
      meta: { name: "get", description: "Read a single property" },
      args: {
        ...sessionArg,
        scope: { type: "positional", required: true, description: "Scope: app | workspace | pane" },
        key: { type: "positional", required: true, description: "Property key" },
        target: { type: "string", description: "Target id for workspace/pane scopes" }
      },
      run: async ({ args }) => {
        const client = await getClient(args.session);
        const request = buildPropertyRequest(args.scope, args.target);
        output(await client.call("props.get", { ...request, key: args.key }));
      }
    }),
    set: defineCommand({
      meta: { name: "set", description: "Write a property value" },
      args: {
        ...sessionArg,
        scope: { type: "positional", required: true, description: "Scope: app | workspace | pane" },
        key: { type: "positional", required: true, description: "Property key" },
        value: { type: "positional", required: true, description: "Property value" },
        target: { type: "string", description: "Target id for workspace/pane scopes" },
        json: { type: "boolean", description: "Parse the value as JSON" }
      },
      run: async ({ args }) => {
        const client = await getClient(args.session);
        const request = buildPropertyRequest(args.scope, args.target);
        output(
          await client.call("props.set", {
            ...request,
            key: args.key,
            value: parseCliValue(args.value, !!args.json)
          })
        );
      }
    }),
    watch: defineCommand({
      meta: { name: "watch", description: "Stream property change events" },
      args: {
        ...sessionArg,
        scope: { type: "string", description: "Optional scope filter: app | workspace | pane" },
        key: { type: "string", description: "Optional property key filter" },
        target: { type: "string", description: "Optional target id filter" }
      },
      run: async ({ args }) => {
        const client = await getClient(args.session);
        const identify = await client.call("system.identify", undefined);
        const stream = subscribePropertyChanges(identify.sessionId, (event) => {
          if (args.scope && event.scope !== args.scope) {
            return;
          }
          if (args.key && event.key !== args.key) {
            return;
          }
          if (args.target && String(event.targetId ?? "") !== args.target) {
            return;
          }
          console.log(JSON.stringify(event));
        });
        let stopping = false;

        const close = () => {
          stopping = true;
          stream.close();
          process.exit(0);
        };

        process.on("SIGINT", close);
        process.on("SIGTERM", close);
        void stream.closed.then(() => {
          if (stopping) {
            return;
          }
          console.error("Property stream disconnected.");
          process.exit(1);
        });
        await new Promise(() => {});
      }
    })
  }
});

function buildPropertyRequest(
  scope: string,
  target?: string
): { scope: "app" | "workspace" | "pane"; targetId?: ReturnType<typeof asPaneId> | ReturnType<typeof asTabId> } {
  if (scope !== "app" && scope !== "workspace" && scope !== "pane") {
    throw new Error(`Invalid scope: ${scope}`);
  }

  if (scope === "app") {
    return { scope };
  }

  if (!target?.trim()) {
    throw new Error(`${scope} scope requires --target or positional target id`);
  }

  return {
    scope,
    targetId: scope === "workspace" ? asTabId(target.trim()) : asPaneId(target.trim())
  };
}

function parseCliValue(raw: string, jsonMode: boolean): unknown {
  if (jsonMode) {
    return JSON.parse(raw);
  }

  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  if (raw === "null") {
    return null;
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }
  return raw;
}
