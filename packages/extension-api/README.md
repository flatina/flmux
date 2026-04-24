# @flmux/extension-api

Types and small helpers for building flmux extensions. An extension ships a `manifest.json` plus one or both of a renderer entrypoint (a pane) and a CLI entrypoint (a command). Only types and helpers live here — the runtime is provided by flmux when the extension is loaded.

## Minimal pane extension

```
extensions/myext/
├── manifest.json
├── index.ts
└── package.json
```

**manifest.json**
```json
{
  "id": "myext",
  "name": "My Extension",
  "version": "0.1.0",
  "apiVersion": 5,
  "entrypoints": { "renderer": "dist/index.js" },
  "panes": [{ "kind": "myext", "defaultTitle": "My Pane" }]
}
```

**index.ts**
```ts
import { defineExtension, definePane, type ExtensionPaneContext, type ExtensionPaneInstance } from "@flmux/extension-api";

const myPane = definePane({
  kind: "myext",
  mount: (host, ctx) => new MyPaneRenderer(host, ctx),
  createParams: ({ input }) => ({ note: (input.params as { note?: string } | undefined)?.note ?? "" }),
  getTitle: ({ input }) => input.title?.trim() || "My Pane",
  // Optional: expose pane state under /panes/{id}/myext/...
  pathMount: {
    mountKey: "myext",
    getStateSnapshot: ({ currentParams }) => ({ note: String(currentParams?.note ?? "") }),
    canSetStatePath: ({ relativePath }) => relativePath.length === 1 && relativePath[0] === "note",
    setState: async ({ relativePath, value, setParams, currentParams }) => {
      if (relativePath[0] !== "note") throw new Error(`unsupported path ${relativePath.join("/")}`);
      const note = String(value);
      await setParams({ ...currentParams, note });
      return { value: note };
    }
  }
});

class MyPaneRenderer implements ExtensionPaneInstance {
  constructor(host: HTMLElement, ctx: ExtensionPaneContext) {
    host.textContent = `pane ${ctx.paneId} in workspace ${ctx.workspaceId}`;
  }
  update(params?: Record<string, unknown>) { /* re-render on external state change */ }
  dispose() { /* cleanup subscriptions */ }
}

export default defineExtension({ panes: [myPane] });
```

## Pane context — the three axes

Every pane receives `ExtensionPaneContext` on mount:

- **`shell: ShellClient`** — `get/list/set/call` against flmux's path surface. Lets the pane read app state (`/status/app/origin`), create other panes (`call /panes/new`), write to another pane's subtree, etc.
- **`bus: WorkspaceBusClient`** — transient pub/sub scoped to the current workspace + current renderer client. `publish(topic, payload?)` stamps the pane's id as `sourcePaneId`; `subscribe(topic, handler)` receives events. Topic patterns: `*`, `prefix.*`, exact match. **Subscribers see their own events** — filter with `event.sourcePaneId !== myPaneId` if that matters. Cross-renderer forwarding is a deferred feature; publishes from CLI/HTTP do not reach renderer subscribers today.
- **`state: PaneStateStore`** — `getParams/setParams/patchParams/getTitle/setTitle`. Per-pane, persisted as part of the workspace layout. External writes through `pathMount.setState` go here.

## pathMount — exposing pane internals on the path surface

A `pathMount` lets external callers (CLI, another pane, an AI agent) reach a specific pane's internals via `/panes/{paneId}/<mountKey>/…`. Two scopes:

- **state** (`getStateSnapshot` / `canSetStatePath` / `setState`) — persisted values. Path `/panes/{id}/<mountKey>/…`. Writes go through `setState(ctx, relativePath, value)`. The extension decides which subpaths are writable by returning `true`/`false` from `canSetStatePath`.
- **status** (`getStatusSnapshot`) — runtime-derived, read-only. Path `/status/panes/{id}/<mountKey>/…`.

A CLI command driving this pane from the terminal:

```bash
flmux set /panes/pane.abc/myext/note "hello"
flmux get /panes/pane.abc/myext/note
flmux get /status/panes/pane.abc/myext
```

## CLI extension

Add `entrypoints.cli` and a `commands` array to `manifest.json`:

```json
{
  "entrypoints": { "renderer": "dist/index.js", "cli": "dist/cli.js" },
  "commands": [{ "id": "myext", "description": "Open a myext pane" }]
}
```

**cli.ts**
```ts
import { commonArgs, createFlmuxClient, defineCommand, printJson, toFlmuxCliFlags } from "@flmux/extension-api/cli";

export default defineCommand({
  meta: { name: "myext", description: "Open a myext pane" },
  args: {
    ...commonArgs,
    title: { type: "positional", description: "Title", required: false }
  },
  async run({ args }) {
    const client = await createFlmuxClient(toFlmuxCliFlags(args));
    const result = await client.call("/panes/new", { kind: "myext", place: "right" });
    printJson(result);
  }
});
```

Extension CLI entries default-export a [citty](https://github.com/unjs/citty) `CommandDef` — flmux registers it directly as a root subcommand, so `flmux myext …` goes straight to your `run({ args, rawArgs })`. Spread `commonArgs` into your own `args` to inherit the transport flags (`--origin`, `--client`, `--token`); `createFlmuxClient(flags)` returns a `ShellClient` talking to the flmux HTTP surface; `printJson(value)` writes the canonical stdout format the built-in verbs use.

## Testing without flmux — `@flmux/extension-api/testing`

Separate subpath so nothing bundles into runtime.

```ts
import {
  createTestBus,
  createTestPaneStateStore,
  createTestShellClient,
  createTestPaneContext
} from "@flmux/extension-api/testing";

// Drive a pane through its own interface:
const ctx = createTestPaneContext({
  paneId: "pane.1",
  workspaceId: "ws.1",
  shell: createTestShellClient({
    "get /status/app/origin": () => "http://127.0.0.1:4000"
  }),
  state: createTestPaneStateStore({ params: { note: "init" } })
});
const pane = myPane.mount(document.createElement("div"), ctx);

// Two panes sharing a bus:
const bus = createTestBus("ws.1");
const a = createTestPaneContext({ paneId: "pane.a", workspaceId: "ws.1", bus });
const b = createTestPaneContext({ paneId: "pane.b", workspaceId: "ws.1", bus });
const received: string[] = [];
b.bus.subscribe("signal", (event) => received.push(event.sourcePaneId));
await a.bus.publish("signal", { n: 1 });
// received === ["pane.a"]
```

`createTestBus` replicates flmux's real topic-matching and error-isolation semantics, so behavior verified against it stays true in production.

## Manifest reference

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Non-empty string, unique |
| `name` | yes | Human-readable |
| `version` | yes | SemVer recommended |
| `apiVersion` | yes | Must equal `FLMUX_EXTENSION_API_VERSION` (currently `5`) |
| `entrypoints.renderer` | either renderer or cli | Relative path, stays inside extension dir |
| `entrypoints.cli` | either renderer or cli | Relative path |
| `commands` | required if `cli` set | Array of `{ id, description? }`, unique ids |
| `panes` | optional | Array of `{ kind, defaultTitle? }`, unique kinds |

Validate programmatically with `validateExtensionManifest(json)`.

## Pane host layout

flmux creates the pane's `host` element as a `<div>` with the class `flmux-ext-pane` already set. Default CSS (shipped with flmux):

```css
.flmux-ext-pane {
  height: 100%;
  display: flex;
  flex-direction: column;
}
```

Extensions that need additional classes should use `host.classList.add("...")` rather than `host.className = "..."` — the latter wipes the base class and loses the default fill-the-pane behavior. Overriding any of these properties is a normal CSS cascade: extension stylesheets load after flmux styles, so a rule like `.my-panel { height: auto }` wins with equal specificity.

## Theming

flmux publishes two independent signals for light/dark theming. DOM panes use the CSS custom-property set; canvas / WebGL / wasm panes read the JS signal and map it to their rendering library's own theme API.

### CSS token contract (`--fl-*`)

Reference these names from your extension's styles. Values swap automatically on theme change (via `[data-theme]` on `:root` and `prefers-color-scheme`). The vocabulary follows VS Code Theme Color naming (hyphenated) with an `--fl-` prefix.

**Base**
`--fl-foreground`, `--fl-description-foreground`, `--fl-error-foreground`, `--fl-accent-foreground`, `--fl-accent-foreground-secondary`, `--fl-focus-border`, `--fl-widget-shadow`

**Surface**
`--fl-editor-background`, `--fl-editor-foreground`, `--fl-widget-background`, `--fl-widget-border`, `--fl-contrast-border`

**Tab / panel** (dockview chrome)
`--fl-panel-background`, `--fl-panel-border`, `--fl-tab-active-background`, `--fl-tab-inactive-background`, `--fl-tab-border`

**Form**
`--fl-input-background`, `--fl-input-foreground`, `--fl-input-border`, `--fl-input-placeholder-foreground`

**Button**
`--fl-button-background`, `--fl-button-foreground`, `--fl-button-hover-background`, `--fl-button-secondary-background`, `--fl-button-secondary-foreground`

Extensions shouldn't hardcode hex colors; reach for the nearest token instead. flmux treats this list as a public contract — renames will come with an `apiVersion` bump.

### JS mode signal (canvas / WebGL / wasm)

Libraries that paint outside the DOM (xterm.js, CodeMirror, charting libraries) can't consume CSS variables at draw time. For those, read the current mode and pair it with the library's own theme API:

```ts
const mode = document.documentElement.dataset.theme === "light" ? "light" : "dark";
term.options.theme = mode === "light" ? lightTerminalTheme : darkTerminalTheme;

document.addEventListener("flmux-theme-change", (event) => {
  const next = (event as CustomEvent<{ mode: "dark" | "light" }>).detail.mode;
  term.options.theme = next === "light" ? lightTerminalTheme : darkTerminalTheme;
});
```

- Source of truth: `document.documentElement.dataset.theme` (`"dark" | "light" | undefined`). When absent, the user hasn't set an explicit override and the page follows `prefers-color-scheme`.
- Swap notification: `document.addEventListener("flmux-theme-change", handler)` where `handler` receives `CustomEvent<{ mode: "dark" | "light" }>`. Fires on OS-preference change (when no override is set) and on explicit override.
- Mapping colors to library-specific theme objects (xterm 16-color palette, CodeMirror Compartments, chart theme presets) is the extension's responsibility — flmux only publishes the mode.

## Where to look in flmux for reference behavior

- `packages/core/src/shell/workspaceBus.ts` — real bus implementation `createTestBus` mirrors
- `packages/core/src/shell/model.ts` — path surface (`/status/app`, `/panes`, `/status/panes/{id}`, etc.)
- `extensions/counter/` — minimal pane with writable `pathMount`
- `extensions/cowsay/` — pane + CLI command example
- `extensions/scratchpad/` — pane with richer state
