# flmux

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-black)](https://bun.sh)

Desktop workspace multiplexer built on [Electrobun](https://electrobun.dev/) + [Dockview](https://dockview.dev/) + [Bun](https://bun.sh). Combines terminal, browser, editor, file explorer, and extension panes in a tiled layout — accessible as native desktop app and via web browser.

## Features

- [Electrobun](https://electrobun.dev/) based native browser panes (WebView2 on Windows, WebKit on macOS)
- [Dockview](https://dockview.dev/) based layout
  - Outer tabs for separate workspaces, inner splits for arranging panes side by side
- [xterm.js](https://xtermjs.org/) based terminal panes
- [CodeMirror](https://codemirror.net/) based text editor panes (JS/TS/JSON/HTML/CSS/Markdown)
- File explorer panes
- Extension system for custom pane types and CLI commands
- External ptyd process: terminal sessions survive app crashes
- Web access: open the same workspace in a browser via WebSocket
- Browser automation: `flmux browser` + `flweb` CLI for scripted browser interaction
- CLI: create panes, switch tabs, manage sessions, inspect/set properties

## Install

### flget (recommended)

```powershell
flget install flatina/flmux --source ghr
```

### GitHub Releases

Download the latest release archive from [Releases](https://github.com/flatina/flmux/releases), extract it, and run `bin/launcher.exe`.

### From source

```powershell
bun install
bun run start
```

The app opens with a single workspace tab containing a terminal. Use the titlebar buttons or the `➕` menu in pane headers to add more panes.

## GUI Actions

### Titlebar

Titlebar buttons launch workspace actions. Built-in launchers include terminal (`>_`), browser (`🌐`), and session menu (`📑`).

#### Session menu (📑)

- Save Session… — Save current layout with a name
- Load Session… — Browse and load a saved session
- Load Last Session — Restore the most recent auto-saved layout

### Inner pane actions

Each workspace tab has:

- a `➕` group menu in the inner header for adding panes within the current group
- a left icon menu on each pane tab for pane-specific commands

The `➕` menu shows a placement grid:

- rows are pane sources (`Editor`, `Explorer`, `Browser`, `Terminal`, plus extension pane sources like `Cowsay`)
- columns are placement targets:
  - `←` split left
  - `→` split right
  - `●` add within the current tab group
  - `↓` split down
  - `↑` split up
- clicking the row source button uses that source's default placement
  - `Explorer` defaults to left
  - `Editor` and `Terminal` default to within
  - `Browser` defaults to auto placement

Extension pane sources use the same grid as built-in pane sources. Arbitrary extension workspace actions, if any, appear in a separate section below the grid.


## Web Access

Enable in `flmux.toml`:

```toml
[web]
enabled = true
# host = "127.0.0.1"
# port = 3000
```

Then open `http://127.0.0.1:3000` in any browser. Each web client gets an independent workspace.

## CLI

The flmux command controls tabs in the same workspace.

```powershell
flmux summary                          # show workspace state
flmux split --direction right           # split current terminal
flmux split --direction right --cmd "flmux summary"
flmux edit myfile.ts                    # open file in editor
flmux explorer .                        # open file explorer
flmux tab list                          # list workspace tabs
flmux session list                      # list recoverable/running sessions
flmux ptyd status --session <id>        # show daemon lifecycle state
flmux quit                              # close the app
```

If flmux crashes, start it again. When exactly one orphan terminal session exists and no live session is running, flmux will recover that session automatically. If recovery is ambiguous, inspect sessions with `flmux session list` and use `--session <id>` for session-specific commands.

### Browser Automation

`flmux browser` manages browser panes. `flweb` is the hot-path browser automation CLI.

Typical workflow:

```powershell
$env:FLMUX_BROWSER = (flmux browser new https://example.com)
flmux browser connect
flweb snapshot --compact
flweb click @e1
flweb wait load
flweb get url
```

When you need the built-in local test pages from a flmux terminal:

```powershell
$env:FLMUX_BROWSER = (flmux browser new http://127.0.0.1:$env:FLMUX_WEB_PORT/about)
```

Current browser pane management commands:

```powershell
flmux browser new https://example.com
flmux browser list
flmux browser connect --json
flmux browser focus
flmux browser close
```

Current `flweb` commands:

```powershell
flweb snapshot --compact
flweb navigate https://example.com/docs
flweb click @e1
flweb fill @e3 "hello"
flweb fill "label=Email" "user@example.com"
flweb click "text=Focus Name"
flweb get text "role=button[name='Reveal Result']"
flweb press Enter
flweb wait load
flweb wait "#result:not([hidden])"
flweb wait --text "Success"
flweb wait --url "**/dashboard"
flweb wait --fn "document.readyState === 'complete'"
flweb get url
flweb get title
flweb get text @e1
flweb get html #result
flweb get value @e3
flweb get attr @e4 placeholder
flweb get box @e3
flweb eval "document.title"
flweb back
flweb forward
flweb reload
```

Automation targets are explicit:

- `--pane <paneId>`
- or `FLMUX_BROWSER`
- otherwise the command errors

Refs like `@e1` come from `flweb snapshot`. Re-run `snapshot` after page changes if a ref becomes stale.

## Configuration

`flmux.toml` in the project root:

```toml
[app]
restoreLayout = true       # auto-restore last session on startup

[log]
level = "info"             # error | warn | info | debug

[web]
enabled = false            # web UI server
host = "127.0.0.1"
port = 3000
```

## Extensions

Extensions add custom pane types or new CLI commands.

```
ext/cowsay/
  flmux-extension.json    # manifest
  index.ts                 # renderer view lifecycle
  index.html               # UI template asset
  cli.ts                   # CLI command (optional)
```

Renderer extensions export an explicit view object. Each pane gets its own instance via `createInstance(context)`:

```typescript
import { defineView } from "flmux-sdk";

export default defineView({
  createInstance(context) {
    let stop = () => {};

    return {
      async beforeMount(host) {
        host.innerHTML = await context.loadAssetText("./index.html");
      },
      mount(host) {
        context.emit("my:event", { data: 123 });
        stop = context.on("other:event", (e) => console.log(e.data));
        host.dataset.ready = "1";
      },
      update() {
        // optional param update handling
      },
      dispose() {
        stop();
      }
    };
  }
});
```

Manage extensions:

```powershell
flmux ext list
flmux ext disable sample.cowsay
flmux ext enable sample.cowsay          # restart required
```

See `ext/cowsay/` for a complete working example.

## Terminal Hooks

`flmux-hooks.yaml` runs shell commands when a new terminal starts:

```yaml
terminal:
  init:
    - echo "Welcome to flmux"
```

`flmux split --cmd "..."` appends a one-shot startup command after those init hooks for the newly created terminal.

## Development

```powershell
bun run dev                # start with file watching
bun test                   # unit tests (260+ tests)
bun run e2e                # build + end-to-end smoke tests (26 tests)
bun run typecheck          # TypeScript check
bun run lint               # Biome lint
```
