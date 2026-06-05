import type { ExtensionPaneContext, PaneHeaderMenu } from "@flmux/extension-api";
import { defineExtension, definePaneRenderer } from "@flmux/extension-api";

const stylesheetUrl = new URL("./panel.css", import.meta.url).href;
const STYLESHEET_ID = "header-menu-panel-styles";

function ensureStylesheet() {
  if (document.getElementById(STYLESHEET_ID)) return;
  const link = document.createElement("link");
  link.id = STYLESHEET_ID;
  link.rel = "stylesheet";
  link.href = stylesheetUrl;
  document.head.appendChild(link);
}

// ── Pane 1: flat items menu ────────────────────────────────────────────────
// Simplest mode — return a list of items and flmux renders the popup
// (label + optional icon + click handler). `disabled` greys the item out.
function mountItemsPane(host: HTMLElement, context: ExtensionPaneContext) {
  ensureStylesheet();
  host.classList.add("hm-panel");
  host.innerHTML = `
    <h2>Header menu — flat items</h2>
    <p>Click the hamburger on this pane's tab. flmux renders the popup from the items list.</p>
    <pre data-role="log">(no actions yet)</pre>
  `;
  const logEl = host.querySelector<HTMLPreElement>('[data-role="log"]')!;
  const log: string[] = [];

  const render = () => {
    logEl.textContent = log.length === 0 ? "(no actions yet)" : log.join("\n");
  };
  const append = (entry: string) => {
    log.push(`${new Date().toLocaleTimeString()}  ${entry}`);
    render();
  };

  const menu: PaneHeaderMenu = {
    items: [
      { id: "ping", label: "Log a ping", icon: "📌", onClick: () => append("ping") },
      { id: "pong", label: "Log a pong", icon: "🏓", onClick: () => append("pong") },
      {
        id: "clear",
        label: "Clear log",
        onClick: () => {
          log.length = 0;
          render();
        }
      },
      { id: "noop", label: "Disabled action", disabled: true, onClick: () => {} }
    ]
  };
  context.setHeaderMenu(menu);
}

// ── Pane 2: custom build callback ──────────────────────────────────────────
// flmux opens an empty popup div and hands it to `build`. The extension owns
// every child element. Returning a function (or void) — flmux invokes it on
// close. `close()` lets the extension dismiss the popup itself.
function mountBuildPane(host: HTMLElement, context: ExtensionPaneContext) {
  ensureStylesheet();
  host.classList.add("hm-panel");
  host.innerHTML = `
    <h2>Header menu — custom build</h2>
    <p>The popup contents are built by the extension. Useful for sliders, swatch grids, or anything beyond a flat list.</p>
    <div data-role="dot" style="width:64px;height:64px;border-radius:50%;background:#6cf"></div>
  `;
  const dotEl = host.querySelector<HTMLDivElement>('[data-role="dot"]')!;

  const state = { color: "#6cf", size: 24 };
  const applyDot = () => {
    const px = `${state.size * 2}px`;
    dotEl.style.width = px;
    dotEl.style.height = px;
    dotEl.style.background = state.color;
  };
  applyDot();

  const swatches = ["#e74c3c", "#f39c12", "#27ae60", "#3498db", "#9b59b6", "#ecf0f1", "#1abc9c", "#e91e63"];
  const menu: PaneHeaderMenu = {
    build: (container, { close }) => {
      container.classList.add("hm-build-popup");

      const grid = document.createElement("div");
      grid.className = "hm-swatches";
      const swatchButtons: HTMLButtonElement[] = [];
      for (const hex of swatches) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "hm-swatch";
        btn.style.background = hex;
        btn.setAttribute("aria-pressed", String(hex === state.color));
        btn.addEventListener("click", () => {
          state.color = hex;
          applyDot();
          for (const b of swatchButtons) b.setAttribute("aria-pressed", String(b === btn));
        });
        swatchButtons.push(btn);
        grid.append(btn);
      }

      const sizeLabel = document.createElement("label");
      sizeLabel.append("Size");
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "8";
      slider.max = "120";
      slider.value = String(state.size);
      slider.addEventListener("input", () => {
        state.size = Number(slider.value);
        applyDot();
      });
      sizeLabel.append(slider);

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.textContent = "Done";
      closeBtn.addEventListener("click", () => close());

      container.append(grid, sizeLabel, closeBtn);
      // Optional cleanup — runs on close. Useful when the build attaches
      // listeners outside `container` (e.g. on document); none here.
    }
  };
  context.setHeaderMenu(menu);
}

export default defineExtension({
  panes: [
    definePaneRenderer({ kind: "header-menu.items", mount: mountItemsPane }),
    definePaneRenderer({ kind: "header-menu.build", mount: mountBuildPane })
  ]
});
