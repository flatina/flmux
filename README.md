# flmux

- Multiplexing terminals, browsers, and extensions
  - Every pane is scriptable from a CLI — including live browser panes: navigate, click, read, screenshot (like Playwright, but on a pane you can also watch and touch). See [docs/browser-cli.md](docs/browser-cli.md)
  - Built on [Bunite](https://github.com/flatina/bunite) (Bun-native desktop framework)
  - Extensions add panes, CLI, and server entries
- Desktop app or headless web server — same core
- Sessions survive crashes and restarts via external pty daemon(tmux style)
- Single-folder portable — no installation, no system mutation
- Currently Windows; macOS and Linux planned

<!-- TODO(image): docs/images/workbench.png — the workbench with a terminal pane and a
     browser pane docked side by side, plus a small overlay of a `flmux …` CLI command. -->
![flmux workbench](docs/images/workbench.png)

## Quickstart

Requires [Bun](https://bun.sh).

```sh
git clone https://github.com/flatina/flmux && cd flmux
bun install
bun run dev            # builds extensions + renderer, opens the desktop app
```

Drive it with the `flmux` CLI — on PATH inside any flmux terminal pane (a shim is
installed to `.flmux/bin/` on first run); from an outside shell, add that dir to PATH
or use `bun packages/app/src/cli.ts`:

```sh
flmux call /panes/new kind=terminal
flmux call /panes/new kind=browser url=https://example.com
```

Headless web server instead of the desktop window: build once
(`bun run build:extensions`, then in `packages/app` `bun run build:renderer`) and run
`bun src/main.ts --web --port 7777`. Web mode is token/passkey-authenticated — see
[docs/flmux-cli.md](docs/flmux-cli.md#tokens-web-auth).

## Control a browser from the CLI

A browser pane is a live, visible page you script from the CLI — navigate, query the
DOM, click, fill, read, screenshot:

```sh
flmux browser open https://example.com          # open a browser pane
flmux browser navigate https://news.ycombinator.com
flmux browser click "text=new"                  # click by visible text
flmux browser get text ".titleline a"           # read the top story
flmux browser screenshot                        # → base64 PNG
```

Targets are CSS, `text=`, `label=`, `role=`, `testid=`, an `@ref` from `find`, or `x,y`.
Full reference: [docs/browser-cli.md](docs/browser-cli.md).

## Docs

- [docs/flmux-cli.md](docs/flmux-cli.md) — the `flmux` CLI: panes, terminals, workspaces, tokens
- [docs/browser-cli.md](docs/browser-cli.md) — driving browser panes from the CLI
- [packages/extension-api/README.md](packages/extension-api/README.md) — writing extensions (panes, CLI, server entries, user preferences)

## Layout

- `packages/core` — shell model, path/state contract, ptyd terminal stack
- `packages/app` — Bun main, renderer workbench, web server, CLI
- `packages/extension-api` — public pane / shell / bus / CLI contract
- `packages/extension-devkit` — `flmux-ext validate / build / pack`
- `extensions/*` — first-party extensions (cowsay, counter, header-menu, inspector, scratchpad)

## License

[MIT](./LICENSE)
