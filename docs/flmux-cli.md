# flmux CLI

`flmux <subcommand> [...]` — talks to a running flmux app over HTTP using
the ShellModelAPI surface. Extension subcommands are auto-registered.

## Transport flags (every subcommand)

| Flag | Falls back to | Purpose |
|---|---|---|
| `--origin <url>` | `FLMUX_ORIGIN` | Server origin (e.g. `http://127.0.0.1:7777`) |
| `--token <t>` | `FLMUX_TOKEN` | Bearer token (web mode) |
| `--client <id>` | `FLMUX_CLIENT_ID` | Renderer client; auto-picked when only one is connected |
| `--version` | — | Print app version |

## Built-in subcommands

```sh
flmux clients
# → { ok, clients: [{ clientId, workspace? }] }

flmux get /status/app/origin
flmux get /status/workspaces/workspace.1/title

flmux ls /status
flmux ls /status/workspaces
flmux ls /status/workspaces/workspace.1/panes   # panes in a workspace

flmux ls-each-get /status/workspaces
flmux ls-each-get /status/workspaces/workspace.1/panes
# list + get every entry in one shot

flmux set /title "My title"
flmux set /workspaces/workspace.1/title "Plots"
flmux set /panes/<paneId>/title "Renamed pane"

flmux call /workspaces/new title="Scratch"
flmux call /workspaces/workspace.1/setActive
flmux call /workspaces/workspace.2/reset
flmux call /workspaces/workspace.2/delete

flmux call /panes/new kind=cowsay place=right
flmux call /panes/new kind=terminal workspaceId=workspace.1
flmux call /panes/<paneId>/setActive
flmux call /panes/<paneId>/close
```

`set` joins trailing positionals — quoting only needed for shell
interpretation; `flmux set /title hello world` is one value `hello world`.

`call` parses `key=value` after the path; values are JSON-coerced
(`true`, `42`, `"x"`, `{"k":1}` work).

## Terminal panes

```sh
flmux get /status/panes/<paneId>/terminal/runtimeId   # null until attached
flmux call /panes/<paneId>/terminal/write data="echo hi"$'\r'
flmux call /panes/<paneId>/terminal/resize cols=120 rows=40
flmux call /panes/<paneId>/terminal/history maxBytes=4096
flmux call /panes/<paneId>/terminal/kill                # kill runtime; pane stays
```

`write` requires the literal CR (`\r`) to commit a line — bash `$'...'`
quoting handles it.

## Browser panes

Browser panes are fully scriptable — navigate, query the DOM, click/fill, run JS,
screenshot. See **[browser-cli.md](./browser-cli.md)**.

## Tokens (web auth)

```sh
flmux tokens bootstrap                 # one-time setup, prints first token
flmux tokens issue --user alice
flmux tokens revoke --token <t>
flmux tokens list
flmux tokens users
flmux tokens qr --origin <url> --token <t>   # ASCII QR for mobile attach
```

`--auth-dir <path>` overrides the default `<rootDir>/.flmux/auth/`.

## Extension subcommands

Defined per extension via `defineExtensionCommand(...)`
(`@flmux/extension-api/cli`). Discovered from each extension's manifest
at CLI start.

```sh
flmux cowsay "moo"            # opens a cowsay pane (right of active)
flmux <ext-cmd> --help
```

Extension authors receive `parsedArgs`, `ctx.dataDir` (per-extension data
dir under `<rootDir>/.flmux/ext/<id>/`), and `rawArgs` inside `run`.

## Quick recipes

```sh
# Snapshot the current shell state
flmux ls-each-get /status > snapshot.json

# Add a workspace and immediately put a terminal in it
ws=$(flmux call /workspaces/new title="dev" | jq -r '.result.value.workspaceId')
flmux call /panes/new kind=terminal workspaceId=$ws

# Read every pane's title in workspace.1
flmux ls /status/workspaces/workspace.1/panes \
  | jq -r '.result.entries[].path' \
  | while read p; do flmux get "$p/title"; done
```
