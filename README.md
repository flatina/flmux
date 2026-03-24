# flmux

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-black)](https://bun.sh)

Terminal/Browser on Dockview on Electrobun with some additional features.

## Features

- Electrobun(https://electrobun.dev/) based native or embedded (CEF) browser tab
- DockView(https://dockview.dev/) based layout
  - Outer tabs for separate workspaces, inner splits for arranging panes side by side
- xterm.js(https://xtermjs.org/) based terminal tab
  - libghostty-vt(https://ghostty.org/) support planned
- CodeMirror(https://codemirror.net/) based text editor tab
- File explorer tab
- Extensions tab for additional content
- external ptyd process: sessions persist even if flmux crashes
- Web access: Open the same workspace in a browser via WebSocket
- CLI Script: create panes, switch tabs, send events

## Install

### flget (recommended)

```powershell
flget install flatina/flmux --source ghr
```

### GitHub Releases

Download the latest zip from [Releases](https://github.com/flatina/flmux/releases), extract, and run `bin/launcher.exe`.

### From source

```powershell
bun install
bun run start
```

The app opens with a single workspace tab containing a terminal. Use the titlebar buttons to add more terminals (`>_`) or browsers (`🌐`).

## GUI Actions

### Workspace actions

| Button | Action |
|--------|--------|
| >_ | Create new workspace and add a terminal tab |
| 🌐 | Create new workspace and add a browser tab |
| 📑 | Show session menu |

#### Session menu (📑)

- Save Session… — Save current layout with a name
- Load Session… — Browse and load a saved session
- Load Last Session — Restore the most recent auto-saved layout

### Inner pane actions

Each workspace tab has header buttons for adding panes within the current split group:

| Button | Action |
|--------|--------|
| 📁 | Add file explorer (split left) |
| >_ | Add terminal (same group) |
| 🌐 | Add browser (split right) |
| ◫ | Split right |
| ⊟ | Split down |


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
flmux edit myfile.ts                    # open file in editor
flmux explorer .                        # open file explorer
flmux tab list                          # list workspace tabs
flmux quit                              # close the app
```

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

[ptyd]
stopOnExit = true          # stop terminal daemon on app exit
```

## Extensions

Extensions add custom pane types or new CLI commands.

```
ext/cowsay/
  flmux-extension.json    # manifest
  index.ts                 # UI (mount function)
  cli.ts                   # CLI command (optional)
```

An extension receives a host DOM element and a context with event bus access:

```typescript
export const mount: ExtensionMount = (host, context) => {
  context.emit("my:event", { data: 123 });
  context.on("other:event", (e) => console.log(e.data));

  host.textContent = "Hello!";
  return { dispose() { /* cleanup */ } };
};
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

## Development

```powershell
bun run dev                # start with file watching
bun test                   # unit tests (90 tests)
bun run e2e                # end-to-end tests
bun run typecheck          # TypeScript check
bun run lint               # Biome lint
```
