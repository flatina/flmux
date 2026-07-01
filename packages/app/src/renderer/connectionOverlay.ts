// Web-mode connection-loss UX. bunite's web WS does not auto-reconnect, so a
// dropped connection (e.g. flmux server restart) would otherwise freeze the UI
// with no signal. On `conn.onClose`, show a blocking overlay and poll the server,
// reloading once it is reachable again — a fresh page reuses the normal bootstrap
// + session resume to restore state. (Depends on bunite firing `onClose` for a
// real WS close, not only explicit `conn.close()`.)

interface CloseInfo {
  code?: number;
  reason?: string;
}

interface Closable {
  onClose(handler: (info?: CloseInfo) => void): () => void;
}

const OVERLAY_ID = "flmux-connection-lost";
const STYLE_ID = "flmux-connection-lost-style";

let shown = false;

export function installConnectionLossOverlay(conn: Closable): void {
  conn.onClose((info) => {
    // Only a real socket death carries CloseInfo. An intentional teardown closes
    // the connection cleanly (e.g. logout calls conn.close()) → info undefined →
    // no overlay.
    if (info) showConnectionLoss();
  });
}

// Exported for a devMode test hook (`__flmuxTest.simulateConnectionLoss`) since a
// real WS close can't be provoked without restarting the server. Idempotent.
export function showConnectionLoss(): void {
  if (shown) return;
  shown = true;
  renderOverlay();
  void reconnectThenReload();
}

function renderOverlay(): void {
  if (document.getElementById(OVERLAY_ID)) return;
  injectStyles();
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.setAttribute("role", "alertdialog");
  overlay.setAttribute("aria-live", "assertive");
  overlay.innerHTML = `<div class="flmux-conn-lost__card">
    <div class="flmux-conn-lost__spinner" aria-hidden="true"></div>
    <div class="flmux-conn-lost__title">Connection lost</div>
    <div class="flmux-conn-lost__msg">Reconnecting…</div>
    <button class="flmux-conn-lost__reload" type="button">Reload now</button>
  </div>`;
  overlay.querySelector("button")?.addEventListener("click", () => location.reload());
  document.body.appendChild(overlay);
}

async function reconnectThenReload(): Promise<void> {
  // Stays until the server returns, then reloads. Backoff caps at 5s.
  for (let delayMs = 1000; ; delayMs = Math.min(Math.round(delayMs * 1.5), 5000)) {
    await sleep(delayMs);
    if (await serverReachable()) {
      location.reload();
      return;
    }
  }
}

async function serverReachable(): Promise<boolean> {
  try {
    const res = await fetch(location.pathname, { method: "HEAD", cache: "no-store" });
    // A 5xx (e.g. a tunnel/proxy 502 while the origin is still down) is not the
    // app — reloading onto it strands the user. Any app response (2xx/3xx/401)
    // means we're back.
    return res.status < 500;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
#${OVERLAY_ID} { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center;
  background: rgba(9, 16, 26, 0.72); font: 14px/1.5 system-ui, sans-serif; color: #e6eefc; }
#${OVERLAY_ID} .flmux-conn-lost__card { display: grid; gap: 12px; justify-items: center; padding: 28px 36px;
  border: 1px solid #32445f; border-radius: 12px; background: #111c2d; text-align: center; }
#${OVERLAY_ID} .flmux-conn-lost__title { font-size: 16px; font-weight: 600; }
#${OVERLAY_ID} .flmux-conn-lost__msg { opacity: 0.75; }
#${OVERLAY_ID} .flmux-conn-lost__spinner { width: 28px; height: 28px; border-radius: 50%;
  border: 3px solid #32445f; border-top-color: #6ea8ff; animation: flmux-conn-lost-spin 0.8s linear infinite; }
#${OVERLAY_ID} .flmux-conn-lost__reload { margin-top: 4px; padding: 6px 14px; border: 1px solid #3f5e87;
  border-radius: 8px; background: #16263d; color: #e6eefc; cursor: pointer; font: inherit; }
#${OVERLAY_ID} .flmux-conn-lost__reload:hover { background: #1d3352; }
@keyframes flmux-conn-lost-spin { to { transform: rotate(360deg); } }`;
  document.head.appendChild(style);
}
