# Driving browser panes from the CLI

A **browser pane** is a live, visible web page — and every part of it is scriptable
via `flmux browser …`. Navigate it, query the DOM, click and type, run JS, screenshot.
Unlike a headless automation run, you can watch and touch the same pane by hand.

Commands target the **first browser pane** by default; pass `--pane <id>` to pick one
(`flmux browser list` shows them). See [flmux-cli.md](./flmux-cli.md) for transport flags.

`flweb` is a shim for `flmux browser` (installed alongside `flmux` in `.flmux/bin/`), so
`flweb open <url>` == `flmux browser open <url>`.

## Open / navigate

```sh
flmux browser open https://example.com          # new pane (or --pane to navigate an existing one)
flmux browser navigate https://news.ycombinator.com
flmux browser back
flmux browser reload
```

## Read the page

```sh
flmux browser get title
flmux browser get text "h1"                     # innerText of a target
flmux browser find text "Sign in"               # → a stable @ref you can reuse
flmux browser snapshot                          # accessibility tree with @refs
```

## Interact

```sh
flmux browser click "text=Sign in"
flmux browser fill  "#email" "me@example.com"
flmux browser type  "hello"
flmux browser press Enter
flmux browser select "#country" "KR"
```

## Run JS / capture

```sh
flmux browser eval "document.title"
flmux browser screenshot                        # → base64 PNG
flmux browser wait idle
```

## Targeting elements

Ops that act on an element take a **target**, resolved as:

| Form | Meaning |
|---|---|
| `@e1` | a ref from `find` / `snapshot` |
| `text=Save` | visible text |
| `label=Email` | accessible label |
| `role=button[name='Save']` | ARIA role (+ optional name) |
| `testid=submit` | `data-testid` |
| `120,240` | raw viewport x,y |
| anything else | CSS selector |

`find <by> <value>` (`by` = `role|text|label|testid`) returns an `@ref` that stays valid
until the page reloads — handy to resolve once and reuse.

## All subcommands

`open` `navigate` `back` `reload` · `click` `dblclick` `hover` `focus` `type` `press`
`scroll` `scroll-to` `fill` `check` `uncheck` `select` · `find` `snapshot`
`get {text|html|value|attr|box|count|url|title}` `is {visible|enabled|checked}` · `wait`
`eval` `screenshot` `highlight` `capabilities` · `dialog {accept|dismiss}` `console list`
`errors` · `list` `focus-pane` `close-pane`. Add `--help` to any for its args.

## Recipe — log in and read a result

```sh
flmux browser open https://example.com/login
flmux browser fill  "#user" "alice"
flmux browser fill  "#pass" "secret"
flmux browser click "role=button[name='Log in']"
flmux browser wait  ".welcome"                  # wait for the post-login element
flmux browser get text ".welcome"
```

---

Under the hood these are the pane path surface — `set /panes/<id>/browser/url` and
`call /panes/<id>/browser/<op>` — so non-CLI callers (HTTP, extensions) drive browser
panes the same way. `flmux browser` just wraps them and resolves the pane for you.
