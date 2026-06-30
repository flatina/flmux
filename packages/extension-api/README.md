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
  "apiVersion": 1,
  "entrypoints": { "renderer": "dist/index.js" },
  "panes": [{ "kind": "myext", "defaultTitle": "My Pane" }]
}
```

flmux loads `server.ts` in the Bun process and `index.ts` in the browser. The two entries never share evaluation contexts, so renderer code (DOM globals, top-level `bootstrap`) is safe.

**server.ts** — host-side pane spec (`lifecycle` / `pathMount` / `persistence`):
```ts
import { defineExtensionServer, definePaneSpec } from "@flmux/extension-api";

export default defineExtensionServer({
  panes: [
    definePaneSpec({
      kind: "myext",
      createParams: ({ input }) => ({ note: String((input.params as any)?.note ?? "") }),
      pathMount: {
        mountKey: "myext",
        getStateSnapshot: ({ currentParams }) => ({ note: String(currentParams?.note ?? "") }),
        canSetStatePath: ({ relativePath }) => relativePath.length === 1 && relativePath[0] === "note",
        setState: async ({ value, setParams, currentParams }) => {
          const note = String(value);
          await setParams({ ...currentParams, note });
          return { value: note };
        }
      }
    })
  ]
});
```

**index.ts** — renderer-side mount only:
```ts
import { defineExtension, definePaneRenderer, type ExtensionPaneContext, type ExtensionPaneInstance } from "@flmux/extension-api";

class MyPaneRenderer implements ExtensionPaneInstance {
  constructor(host: HTMLElement, ctx: ExtensionPaneContext) {
    host.textContent = `pane ${ctx.paneId} in workspace ${ctx.workspaceId}`;
  }
  update(params?: Record<string, unknown>) { /* re-render */ }
  dispose() { /* cleanup */ }
}

export default defineExtension({
  panes: [definePaneRenderer({ kind: "myext", mount: (host, ctx) => new MyPaneRenderer(host, ctx) })]
});
```

Renderer-only extensions (no `pathMount`, only manifest-level `defaultTitle`) can skip `server.ts` entirely.

## HTTP routes

A server entry can serve dynamic HTTP at `/api/ext/<extId>/<path>` — for external packages or environments that require a real same-origin HTTP endpoint (use cap/RPC for everything security-sensitive). flmux owns the security envelope (auth, rate-limit, CORS, header filtering, error scrubbing); your handler only computes a body.

```ts
import { defineExtensionServer } from "@flmux/extension-api";
import { createHmac, randomBytes } from "node:crypto";

export default defineExtensionServer({
  httpRoutes: [{
    method: "GET",
    path: "/token",
    auth: "public", // "public" is GET-only; "session" adds auth + entitlement
    handler: () => {
      const secret = process.env.MY_EXT_SECRET ?? ""; // or read from ctx.dataDir
      if (!secret) return { status: 503, body: "secret not set" };
      const nonce = randomBytes(8).toString("hex");
      const expiry = Math.floor(Date.now() / 1000) + 7 * 86400;
      const hmac = createHmac("sha256", Buffer.from(secret, "hex")).update(`${nonce}:${expiry}`).digest("hex");
      return `${nonce}:${expiry}:${hmac}`; // bare string ⇒ text/plain body
    }
  }]
});
```

- **`auth`** — `"session"` runs behind flmux auth + the per-user extension entitlement (`ctx.userId` is the caller; `null` on public, `"local"` on desktop). `"public"` is unauthenticated and GET-only.
- **Return** — `ExtensionHttpResponse` (`{ status?, headers?, body? }`) or a bare `string`/`Uint8Array`/`ArrayBuffer` (content-type defaults to `text/plain`).
- **flmux owns CORS** — you cannot set `Access-Control-Allow-Origin` (responses stay same-origin), `set-cookie`, or CSP; only a small content-type/caching header allow-list passes through. `ctx.request.header()` redacts `cookie`/`authorization`.
- Read your own config/secret from `ctx.dataDir`.

## Pane context

Every pane receives `ExtensionPaneContext` on mount:

- **`shell: ShellClient`** — `get/list/set/call` against flmux's path surface. Lets the pane read app state (`/status/app/origin`), create other panes (`call /panes/new`), write to another pane's subtree, etc.
- **`bus: WorkspaceBusClient`** — transient pub/sub scoped to the current workspace + current renderer client. `publish(topic, payload?)` stamps the pane's id as `sourcePaneId`; `subscribe(topic, handler)` receives events. Topic patterns: `*`, `prefix.*`, exact match. **Subscribers see their own events** — filter with `event.sourcePaneId !== myPaneId` if that matters. Cross-renderer forwarding is a deferred feature; publishes from CLI/HTTP do not reach renderer subscribers today.
- **`workspaceStatus: WorkspaceStatusStoreClient`** — retained KV store shared with every pane in the same workspace. Non-persistent. `subscribe(key, fn)` replays the current value (or `undefined`) immediately, then emits on change; `Object.is`-equal `set` calls suppress emit. Subscriptions auto-unsubscribe when the pane disposes. Use this for transient cross-pane status (selection, cursor, hover) — `bus` is the right tool when you only need the event, `workspaceStatus` is the right tool when late mounts also need the *current value*.
- **`state: PaneStateStore`** — `getParams/setParams/patchParams/getTitle/setTitle`. Per-pane, persisted as part of the workspace layout. External writes through `pathMount.setState` go here.
- **RPC** — extensions define their own bunite cap and call `bootstrap()` from `bunite-core/rpc/renderer`. There's no `channel()` on the pane context; instead the extension owns its proxy at module scope and every pane awaits the shared promise.

**schema.ts** (host + renderer both import):
```ts
import { call, defineCap, stream } from "bunite-core/rpc";

export const myCap = defineCap("my.ext", {
  ping: call<{value: string}, {pong: string}>(),
  events: stream<void, MyEvent>()
});
```

**server.ts**:
```ts
import { Stream } from "bunite-core/rpc";
import { defineExtensionServer } from "@flmux/extension-api";
import { myCap } from "./schema";

export default defineExtensionServer({
  onSession(ctx) {
    // sessionId/userId 는 closure 가 capture — wire 위로 carry 0.
    ctx.serve(myCap, {
      ping: ({value}) => ({pong: `pong:${value}`}),
      events: () => Stream.from((emit, signal) => {
        const t = setInterval(() => emit({/* ... */}), 1000);
        signal.addEventListener("abort", () => clearInterval(t));
      })
    });
    ctx.onDispose(() => { /* per-session teardown — fires on connection close */ });
  }
});
```

`onSession` 은 매 session (post-auth) 마다 1회 실행. impl closure 가 `ctx.sessionId`/`ctx.userId` 를 자유로이 사용 — 매 cap call 마다 caller-declared identity 없이 server-known.

**renderer index.ts**:
```ts
import { bootstrap } from "bunite-core/rpc/renderer";
import { defineExtension, definePaneRenderer } from "@flmux/extension-api";
import { myCap } from "./schema";

let rpcReady: Promise<Awaited<ReturnType<typeof bootstrap<typeof myCap>>>> | null = null;

export default defineExtension({
  panes: [definePaneRenderer({
    kind: "my.ext",
    mount: (host, ctx) => {
      void (async () => {
        const rpc = await rpcReady!;
        const { pong } = await rpc.ping({ value: "hi" });
        // ...
      })();
    }
  })],
  onLoad() {
    // host onSession 이 connection 에 cap 을 serve 한 직후 호출됨 — bootstrap 안전.
    rpcReady = bootstrap(myCap);
  }
});
```

Cap names use reverse-domain (`<orgDomain>.<extId>`); `bunite.*` / `flmux.*` reserved for the framework. RPC is decoupled from pane lifecycle — `onSession` runs once per session, pane creation/destruction never re-runs handshake.

## Tab-header menu

Every pane gets a hamburger button before its tab title. Click opens a popup whose contents come from the pane runtime via `ctx.setHeaderMenu(menu)`:

```ts
ctx.setHeaderMenu({
  items: [
    { id: "refresh", label: "Refresh", icon: "🔄", onClick: () => reload() },
    { id: "settings", label: "Settings…", onClick: () => openSettings() }
  ]
});

// Or own the popup contents:
ctx.setHeaderMenu({
  build(container, { close }) {
    const ui = renderCustomMenu(container, close);
    return () => ui.dispose();
  }
});

ctx.setHeaderMenu(null); // remove
```

If no menu is set, the click is a no-op. The button can be replaced with a custom icon via the manifest `panes[].icon` field.

## pathMount — exposing pane internals on the path surface

A `pathMount` lets external callers (CLI, another pane, an AI agent) reach a specific pane's internals via `/panes/{paneId}/<mountKey>/…`. Three scopes:

- **state** (`getStateSnapshot` / `canSetStatePath` / `setState`) — persisted values. Path `/panes/{id}/<mountKey>/…`. Writes go through `setState(ctx, relativePath, value)` and are gated by `canSetStatePath`; the leaf must already exist in `getStateSnapshot` and be a primitive (the shell reuses the snapshot as the writability contract).
- **call** (`canCallStatePath` / `callState`) — RPC-style actions with computed return values. Path `shell.call /panes/{id}/<mountKey>/<op>` with `args`. Unlike `setState`, `callState` has no snapshot-leaf requirement — a mount can expose `callState`/`canCallStatePath` alone, without a `getStateSnapshot`, for pure-RPC panes. Return shape `{ value: unknown }`. Throwing `ModelPathError(code, msg)` preserves the code; throwing a plain `Error` becomes `INTERNAL_ERROR` with the error's message. **`canCallStatePath` is required** — it defaults to `false`, so a mount that defines `callState` without its gate will respond `NOT_CALLABLE` to every op.
- **status** (`getStatusSnapshot`) — runtime-derived, read-only. Path `/status/panes/{id}/<mountKey>/…`.

`call` is gated by `allow_paths.call` on the shared ShellModelAPI ACL (same gate that guards every other `shell.call` path). Preload/WS remain trusted.

A CLI command driving this pane from the terminal:

```bash
flmux set /panes/pane.abc/myext/note "hello"
flmux get /panes/pane.abc/myext/note
flmux get /status/panes/pane.abc/myext
flmux call /panes/pane.abc/myext/search query=cpu
```

## CLI extension

Add `entrypoints.cli` and a `commands` array to `manifest.json`:

```json
{
  "entrypoints": { "renderer": "dist/index.js", "cli": "dist/cli.js" },
  "commands": [
    { "id": "myext", "description": "Open a myext pane", "shim": "myext" }
  ]
}
```

The optional `shim` field is opt-in: when set, flmux writes a PATH shim at `<rootDir>/.flmux/bin/<shim>{,.cmd}` that forwards to `flmux <id>`, so terminal users can type `myext …` directly instead of `flmux myext …`. Leave it off and the command stays reachable only through the `flmux` root (no automatic PATH pollution). Names that collide with a built-in flmux subcommand (`clients`, `get`, `ls`, `ls-each-get`, `set`, `call`, `tokens`) or with another extension's shim are skipped with a console warning.

**cli.ts**
```ts
import {
  commonArgs,
  createFlmuxClient,
  defineExtensionCommand,
  printJson,
  toFlmuxCliFlags
} from "@flmux/extension-api/cli";

export default defineExtensionCommand({
  meta: { name: "myext", description: "Open a myext pane" },
  args: {
    ...commonArgs,
    title: { type: "positional", description: "Title", required: false }
  },
  async run(parsedArgs, ctx) {
    // ctx.dataDir is flmux-injected; the extension never claims its own id.
    const client = await createFlmuxClient(toFlmuxCliFlags(parsedArgs));
    const result = await client.call("/panes/new", { kind: "myext", place: "right" });
    printJson(result);
  }
});
```

Extension CLI entries default-export `defineExtensionCommand({...})`. flmux wraps it as a [citty](https://github.com/unjs/citty) subcommand, dispatches `flmux myext …` straight to your `run(parsedArgs, ctx, rawArgs)`, and supplies `ctx` with the flmux-controlled context (currently `dataDir`). Spread `commonArgs` into your own `args` to inherit the transport flags (`--origin`, `--client`, `--token`); `createFlmuxClient(flags)` returns a `ShellClient` talking to the flmux HTTP surface; `printJson(value)` writes the canonical stdout format the built-in verbs use.

### Column-fill placement helper

For consumers that spawn many panes (plot dashboards, AI agents, etc.) the default `--place right` quickly produces tall narrow columns. `resolveColumnFillPlacement(client, { workspaceId, isTargetKind, maxRowsPerColumn, maxColumns })` packs new panes into a `maxColumns × maxRowsPerColumn` grid by inspecting `/status/workspaces/<id>/panes`, counting only `isTargetKind` panes. For `n` existing target panes (`cap = maxColumns · maxRowsPerColumn`):

- `n = 0` → `{ place: "right" }` (split off the workspace)
- `n ≥ cap` (grid full) → `{ place: "within", referencePaneId: <targets[n % cap]> }` (tab into a cell, round-robin by creation order so tab counts stay balanced)
- `n` a multiple of `maxRowsPerColumn` → `{ place: "right" }` (new column; referencePaneId omitted so Dockview splits at the root)
- otherwise → `{ place: "below", referencePaneId: <last target> }` (extend the column the last one is in)

Available from `@flmux/extension-api` (renderer pane mounts, server entries) and `@flmux/extension-api/cli` (CLI commands) — same helper, takes any `ShellClient`:

```ts
// CLI:
import { resolveColumnFillPlacement } from "@flmux/extension-api/cli";
// Renderer / server entry:
import { resolveColumnFillPlacement } from "@flmux/extension-api";

const placement = await resolveColumnFillPlacement(client, {
  workspaceId,
  isTargetKind: (kind) => kind.startsWith("myext-"),
  maxRowsPerColumn: 4,
  maxColumns: 3
});
await client.call("/panes/new", { kind: "myext-trend", ...placement });
```

The heuristic uses creation order as a proxy for spatial layout — not a guarantee. After manual drag or close, the most recently created target may no longer be in the rightmost column, and "extend" extends the wrong one until the next pane is created. It's also not concurrency-safe: two callers racing on the same workspace can pick the same placement. Always allow an explicit `--place` override for those cases.

## Persistent state — `.flmux/ext/<id>/`

flmux carves a per-extension data directory at `<rootDir>/.flmux/ext/<extensionId>/` and hands it to the extension as a readonly `ctx.dataDir` field. flmux is the one running the extension, so the extension never claims its own id — it just reads `ctx.dataDir`. The directory is the extension's writable space; flmux makes no assumptions about its layout (sessions, configs, caches, etc. all welcome) and mkdirs lazily on first need.

- **Server entry** — `ctx.dataDir` is supplied to `onInit(ctx)` (1× process), `serve(ctx)` (1× connection, sync — RPC is bound here), `onClientConnected(clientId, ctx)` (1× client, post-register notification), and `onPaneConnected(paneId, clientId, ctx)` (pane lifecycle notification).
- **CLI entry** — `ctx.dataDir` is supplied to `run(parsedArgs, ctx, rawArgs)` (see "CLI extension" above). Use `defineExtensionCommand` from `@flmux/extension-api/cli` so flmux can inject it.
- **Renderer** — no direct fs access (browser context). Forward writes through a cap method to the server entry.

```ts
import { defineExtensionServer } from "@flmux/extension-api";
import { myCap } from "./schema";

export default defineExtensionServer({
  async onInit(ctx) {
    // 1× per process. db open, schema migration, shared workers, etc.
    await openDb(`${ctx.dataDir}/store.db`);
  },
  serve(ctx) {
    // 1× per connection, synchronous. No `await` before `conn.serve` —
    // flmux relies on the registry being populated before bunite processes
    // the first incoming frame.
    const handle = ctx.connection.serve(myCap, makeImpl());
    return { dispose: () => ctx.connection.unserve(handle) };
  },
  async onClientConnected(clientId, ctx) {
    // 1× per client (post-register). Async per-user init goes here — no
    // cap binding (that's `serve`'s job).
    return { dispose: () => { /* per-client cleanup */ } };
  },
  async onPaneConnected(paneId, clientId, ctx) {
    return { dispose: () => { /* per-pane bookkeeping cleanup */ } };
  }
});
```

```ts
// In an extension CLI entry
import { commonArgs, defineExtensionCommand, printJson } from "@flmux/extension-api/cli";

export default defineExtensionCommand({
  meta: { name: "myext-where" },
  args: { ...commonArgs },
  async run(_parsedArgs, ctx) {
    printJson({ dataDir: ctx.dataDir });
  }
});
```

For multi-user web setups, partition under the data dir using the client's user (`ctx.shell.get("/status/clients/<id>/userId")`), e.g. `<dataDir>/users/<userId>/`. Cross-user isolation is the extension's responsibility once it's inside its own dir.

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
| `apiVersion` | yes | Must equal `FLMUX_EXTENSION_API_VERSION` (currently `1`) |
| `entrypoints.renderer` | either renderer or cli | Relative path, stays inside extension dir |
| `entrypoints.cli` | either renderer or cli | Relative path |
| `commands` | required if `cli` set | Array of `{ id, description? }`, unique ids |
| `panes` | optional | Array of `{ kind, defaultTitle?, singletonScope?, icon? }`, unique kinds. `singletonScope: "workspace"` keeps one pane per workspace; `"app"` keeps one across the whole shell (active only when it lives in caller's active workspace — never auto-switches workspaces). `icon` is a relative path to an SVG/PNG file that replaces the default hamburger glyph on the pane's tab header. Each pane's last activation is published at `/status/panes/{id}/lastActive` as `{at, source: "user" \| "call"}` — pass `args.source = "user"` from `/panes/{id}/setActive` for human-driven activations (mouse/keyboard), default `"call"` for programmatic ones. |
| `build.alias` | optional | **Build-time only — stripped from the shipped manifest.** `{ "<import-specifier>": "<replacement>" }` redirects an exact bare import specifier to a replacement module during `flmux-ext build`, via a Bun `onResolve` plugin that intercepts the specifier graph-wide (incl. deep transitive deps — where `tsconfig` `paths` doesn't reach). Use to swap a heavy dependency for a trimmed variant. The replacement is inlined like any other module, so the 0-externals self-contained bundle is preserved. `from` must be a bare specifier. `to` is a **`./`-relative path** (kept inside the extension dir — no `..`/absolute) **or a bare specifier** (anything dot-less, node-resolved); a missing target fails the build. A bare `to` resolves with default conditions, so a renderer alias to a package with `browser`/`default` conditional exports should use a direct-file `to`. |

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
- `extensions/header-menu/` — both `setHeaderMenu` modes (flat items + custom build)
- `extensions/scratchpad/` — pane with richer state
