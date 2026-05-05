# flmux

- Multiplexing terminals, browsers, and extensions
  - Built on [Bunite](https://github.com/flatina/bunite) (Bun-native desktop framework)
  - Extensions add panes, CLI, and server entries
- Desktop app or headless web server — same core
- Sessions survive crashes and restarts via external pty daemon(tmux style)
- Single-folder portable — no installation, no system mutation
- Currently Windows; macOS and Linux planned

## Quickstart

- 

## Layout

- `packages/core` — shell model, path/state contract, ptyd terminal stack
- `packages/app` — Bun main, renderer workbench, web server, CLI
- `packages/extension-api` — public pane / shell / bus / CLI contract
- `packages/extension-devkit` — `flmux-ext validate / build / pack`
- `extensions/*` — first-party extensions (cowsay, counter, header-menu, inspector, scratchpad)

## License

[MIT](./LICENSE)
