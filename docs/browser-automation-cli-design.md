# Browser Automation CLI Design

## Goal

Make browser automation a first-class flmux workflow for AI agents:

- create a browser pane from a terminal
- capture the returned pane id
- export it into `FLMUX_BROWSER`
- drive the page through a short hot-path CLI

The design intentionally avoids hidden target-selection state. Automation targets are explicit:

- `--pane <paneId>`
- or `FLMUX_BROWSER`
- otherwise error

## Command Split

Two command surfaces are used:

- `flmux browser ...`
  - flmux-aware browser pane management
- `flweb ...`
  - hot-path page automation against a resolved flmux browser pane

This keeps high-frequency automation verbs short while reserving `flmux` for workspace object management.

## User Workflow

```sh
export FLMUX_BROWSER=$(flmux browser new https://example.com)
flmux browser connect
flweb snapshot
flweb get url
flweb navigate https://example.com/docs
```

The same flow should be documented in the future `flmux browser automation` agent skill.

## flmux browser

`flmux browser` manages browser panes only.

### Commands

- `flmux browser new [url]`
  - creates a new browser pane
  - default output: pane id only
  - example output: `browser.1a2b3c4d`
- `flmux browser list`
  - lists existing browser panes for the target session
  - default output: one pane id per line
- `flmux browser focus [--pane <id>]`
  - focuses a browser pane
  - if `--pane` is omitted, uses `FLMUX_BROWSER`
- `flmux browser close [--pane <id>]`
  - closes a browser pane
  - if `--pane` is omitted, uses `FLMUX_BROWSER`
- `flmux browser connect [--pane <id>]`
  - validates that the pane exists, is a browser pane, and is automation-ready
  - if `--pane` is omitted, uses `FLMUX_BROWSER`

### Output

Default output is always concise text.

- `new`: pane id only
- `focus`: pane id only
- `close`: pane id only
- `connect`: pane id only on success
- `list`: one pane id per line

All commands should support `--json`.

### Session Selection

Management commands should keep the existing `--session` support pattern from the rest of the CLI.

- inside a flmux terminal, `FLMUX_APP_IPC` resolves the session automatically
- outside a flmux terminal, `--session` may be required

## flweb

`flweb` is the hot-path automation CLI.

It never creates or discovers browser panes implicitly.

### Target Resolution

Resolution order:

1. `--pane <paneId>`
2. `FLMUX_BROWSER`
3. error

No fallback to last-active browser pane.

### Commands

Initial MVP:

- `flweb snapshot`
- `flweb navigate <url>`
- `flweb get url`
- `flweb get title`

Planned next wave after runtime stabilization:

- `flweb click <ref-or-selector>`
- `flweb fill <ref-or-selector> <text>`
- `flweb press <key>`
- `flweb get text <ref-or-selector>`
- `flweb get html <ref-or-selector>`
- `flweb get value <ref-or-selector>`
- `flweb get attr <ref-or-selector> <name>`
- `flweb get box <ref-or-selector>`
- `flweb eval <js>`
- `flweb wait <ms-or-selector>`
- `flweb wait load`
- `flweb wait idle [idleMs]`
- `flweb screenshot [path]`
- `flweb back`
- `flweb forward`
- `flweb reload`

### Output

Default output should be command-specific and minimal.

- `snapshot`: text snapshot
- `get url`: URL only
- `get title`: title only
- `click/fill/press/navigate`: success line or pane id is not needed

All commands should support `--json`.

### Error Contract

If no pane is provided:

```text
No browser pane selected.
Set FLMUX_BROWSER first:
  export FLMUX_BROWSER=$(flmux browser new https://example.com)

Or pass a pane explicitly:
  flweb snapshot --pane browser.1a2b3c4d
```

## Internal Architecture

### Shared Browser Automation Service

Implementation should not duplicate logic between `flmux browser` and `flweb`.

A shared module should own:

- pane id resolution
- pane validation
- browser pane summary lookup
- BrowserView resolution from `webviewId`
- page-action execution against the resolved webview

Suggested modules:

- `src/cli/browser-target.ts`
  - resolve pane from `--pane` / env / error
- `src/cli/browser-service.ts`
  - flmux-aware automation operations
- `src/cli/flweb-main.ts`
  - thin citty command surface for hot-path automation

### Runtime Ownership

`flweb` should remain a thin app-RPC client.

Instead:

1. resolve flmux browser pane id
2. ask flmux for live automation metadata for that pane
3. let the flmux app process execute the browser actions through Electrobun's built-in per-webview RPC

This keeps `PaneId` as the stable external handle and keeps page execution inside the owning desktop app process.

## Required RPC Additions

Current app RPC already exposes raw `browser.targets`, but the primary automation path is pane-aware and does not require raw CDP targeting.

Pane-aware browser RPCs should be additive and should not depend on clients manually consuming raw target lists.

### Suggested app RPC methods

- `browser.new`
  - input: `{ url?: string }`
  - result: `{ ok: true, paneId: PaneId }`
- `browser.list`
  - result: `{ ok: true, panes: Array<{ paneId, tabId, title, url }> }`
- `browser.focus`
  - input: `{ paneId: PaneId }`
  - result: `{ ok: true, paneId: PaneId }`
- `browser.close`
  - input: `{ paneId: PaneId }`
  - result: `{ ok: true, paneId: PaneId }`
- `browser.connect`
  - input: `{ paneId: PaneId }`
  - result:
    - `{ ok: true, paneId, url, title, adapter, webviewId }`
    - or `{ ok: false, error, code }`
- `browser.navigate`
  - input: `{ paneId: PaneId, url: string, waitUntil?: "none" | "load" | "idle", idleMs?: number }`
  - result: `{ ok: true, paneId, url }`
- `browser.get`
  - input: `{ paneId: PaneId, field: "url" | "title" }`
  - result: `{ ok: true, paneId, field, value }`
- `browser.snapshot`
  - input: `{ paneId: PaneId, compact?: boolean }`
  - result: `{ ok: true, paneId, snapshot }`
- `browser.click`
  - input: `{ paneId: PaneId, target: string }`
  - result: `{ ok: true, paneId }`
- `browser.fill`
  - input: `{ paneId: PaneId, target: string, text: string }`
  - result: `{ ok: true, paneId }`
- `browser.press`
  - input: `{ paneId: PaneId, key: string }`
  - result: `{ ok: true, paneId }`
- `browser.wait`
  - input: `{ paneId: PaneId, kind: "duration" | "load" | "idle" | "target", target?: string, ms?: number }`
  - result: `{ ok: true, paneId }`

`browser.targets` should stay available for future `flmux cdp` use cases, but it is not the primary automation surface.

## Renderer/Main Responsibilities

### Renderer

Renderer browser panes already know:

- pane id
- current URL
- title
- whether a native webview exists

The renderer should additionally expose enough metadata for main/CLI to resolve a live automation target per pane.

This is implemented via a renderer RPC that lists live browser pane metadata, including:

- pane id
- title
- current URL
- adapter kind
- automation readiness
- native `webviewId` when available

### Main

Main owns the app RPC surface and resolves:

- `paneId -> BrowserPaneInfo`
- `BrowserPaneInfo.webviewId -> BrowserView.getById(webviewId)`

Once the `BrowserView` is resolved, automation runs through Electrobun's built-in webview RPC and `evaluateJavascriptWithResponse`.

## Mapping Strategy

Public handle:

- `PaneId`

Internal live mapping:

- create a native browser pane
- wait for renderer metadata to report `webviewId`
- resolve `BrowserView.getById(webviewId)` in main
- execute page actions through `BrowserView.rpc.request.evaluateJavascriptWithResponse`

This keeps `PaneId` as the external identity and avoids fragile URL/title or CDP-target guessing for the primary path.

## Reference Storage

Refs should not be persisted to disk for the flmux automation path.

The long-lived owner is the flmux app process, not the short-lived `flweb` process.

Design direction:

- snapshots should stamp the page DOM with transient `data-flmux-ref="eN"` attributes
- subsequent commands like `click @e1` should resolve against those DOM attributes
- a fresh snapshot should rewrite the current ref set
- pane close or navigation naturally invalidates stale refs

This avoids stale files and keeps the ref lifecycle local to the active browser page.

## Non-Goals

- no implicit last-active browser target fallback
- no terminal-owned hidden current-browser state
- no shell wrapper magic
- no separate persistent connect session required before `flweb` commands
- no file-backed refs for the flmux automation path

`connect` exists for validation/debugging, not as a mandatory stateful step.

## Open Questions

### 1. Raw CDP Surface Name

Locked:

- keep flmux-aware management under `flmux browser`
- use `flmux cdp` for future raw low-level CDP commands

### 2. Pane-to-Webview Reliability

Current implementation relies on renderer metadata exposing `webviewId`, and main resolving `BrowserView.getById(webviewId)`.

If this proves unreliable in practice, the next escalation path is a tighter Electrobun integration or an explicit flmux-owned webview registry in main.

### 3. Ref Storage Path

Locked:

- do not use a refs file
- do not persist refs outside the live page DOM

### 4. `browser.new` Readiness Semantics

Locked:

- `flmux browser new <url>` should wait until the pane becomes automation-ready before returning the pane id
- `flmux browser new` without a URL should still create an automation-ready blank pane rather than a non-ready welcome-only state
