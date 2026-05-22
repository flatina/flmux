# Browser CLI Fixtures

Static HTML pages for live-testing `flmux browser <subcommand>` against a real browser pane.

## Pages

| File | Purpose |
|---|---|
| `index.html` | Landing + nav links (snapshot/find/get/title/url, back/reload chain) |
| `forms.html` | text/email/textarea, checkbox, radio, select (fill/check/uncheck/select) |
| `interactions.html` | click counter, dblclick, hover, focus, type, press, scroll, async reveal (wait), enabled/disabled/visible/checked state (is), highlight |
| `dialogs.html` | alert / confirm / prompt triggers (dialog accept/dismiss) |
| `console.html` | console.log/warn/error + uncaught throw (console list, errors) |

Shared: `style.css`, `script.js` (page-scoped via `body[data-page]`).

## Loading

`file:///<repo>/packages/app/test/fixtures/browser-cli/index.html` works in any backend that allows local file navigation.
