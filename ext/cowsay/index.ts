import type { ExtensionMount, HeaderAction, PaneEvent } from "../../src/shared/extension-abi";

interface EventLogEntry {
  direction: "sent" | "received";
  type: string;
  source: string;
  scope: "tab" | "global";
  payload: string;
  at: string;
}

interface CowsayState {
  text: string;
  visits: number;
  sentCount: number;
  receivedCount: number;
  lastMountedAt: string;
  lastTitle: string;
  eventLog: EventLogEntry[];
}

const MAX_LOG_ENTRIES = 40;

export const mount: ExtensionMount = (host, context) => {
  const state = normalizeState(context.initialState);
  let text = state.text || "hello flmux";
  let visits = state.visits + 1;
  let sentCount = state.sentCount;
  let receivedCount = state.receivedCount;
  let lastTitle = state.lastTitle || "cowsay lab";
  let lastMountedAt = new Date().toISOString();
  const eventLog = [...state.eventLog];

  const wrapper = document.createElement("div");
  wrapper.style.cssText = [
    "height:100%",
    "display:flex",
    "flex-direction:column",
    "gap:12px",
    "padding:14px",
    "background:linear-gradient(180deg,#11161d,#1a212b)",
    "color:#e8edf2",
    'font-family:"Cascadia Code",Consolas,monospace',
    "box-sizing:border-box"
  ].join(";");

  const header = document.createElement("div");
  header.style.cssText = [
    "display:flex",
    "justify-content:space-between",
    "gap:12px",
    "align-items:flex-start",
    "padding:10px 12px",
    "border:1px solid rgba(255,255,255,0.08)",
    "background:rgba(255,255,255,0.03)",
    "border-radius:10px"
  ].join(";");

  const titleBlock = document.createElement("div");
  const title = document.createElement("div");
  title.textContent = "Cowsay Lab";
  title.style.cssText = "font-size:18px;font-weight:700;";

  const subtitle = document.createElement("div");
  subtitle.textContent = "Interactive fixture for extension state, events, header actions, and restore.";
  subtitle.style.cssText = "margin-top:4px;color:#9db0c3;font-size:12px;max-width:680px;";

  titleBlock.append(title, subtitle);

  const ids = document.createElement("pre");
  ids.style.cssText = [
    "margin:0",
    "font-size:11px",
    "line-height:1.5",
    "color:#9db0c3",
    "text-align:right",
    "white-space:pre-wrap"
  ].join(";");
  ids.textContent = [
    `pane: ${context.paneId}`,
    `tab:  ${context.tabId}`,
    `ext:  ${context.extensionId}/${context.contributionId}`
  ].join("\n");

  header.append(titleBlock, ids);

  const controls = document.createElement("div");
  controls.style.cssText = [
    "display:grid",
    "grid-template-columns:minmax(220px,2fr) repeat(4,minmax(100px,1fr))",
    "gap:8px",
    "align-items:center"
  ].join(";");

  const input = document.createElement("input");
  input.type = "text";
  input.value = text;
  input.placeholder = "Type a message";
  input.style.cssText = fieldStyle();

  const sayBtn = makeButton("Say Tab", "#ffb45e");
  const titleBtn = makeButton("Set Title", "#7fd1b9");
  const resetBtn = makeButton("Reset", "#8ab4ff");
  const clearBtn = makeButton("Clear Log", "#d88cff");

  controls.append(input, sayBtn, titleBtn, resetBtn, clearBtn);

  const hint = document.createElement("div");
  hint.style.cssText = [
    "padding:10px 12px",
    "border-left:3px solid #ffb45e",
    "background:rgba(255,180,94,0.08)",
    "color:#d6dee8",
    "font-size:12px",
    "line-height:1.6"
  ].join(";");
  hint.textContent =
    "Open two cowsay panes in the same workspace and click Say Tab. Use Set Title to verify app:title propagation. Save and reload the session to verify state restore.";

  const content = document.createElement("div");
  content.style.cssText = [
    "display:grid",
    "grid-template-columns:minmax(280px,1.2fr) minmax(280px,1fr)",
    "gap:12px",
    "min-height:0",
    "flex:1 1 auto"
  ].join(";");

  const left = document.createElement("div");
  left.style.cssText = "display:flex;flex-direction:column;gap:12px;min-height:0;";

  const cowCard = makeCard("Preview");
  const cowOutput = document.createElement("pre");
  cowOutput.style.cssText = [
    "margin:0",
    "white-space:pre-wrap",
    "color:#f3f6f8",
    "font-size:13px",
    "line-height:1.35",
    "overflow:auto"
  ].join(";");
  cowCard.body.append(cowOutput);

  const statsCard = makeCard("State");
  const stats = document.createElement("pre");
  stats.style.cssText = [
    "margin:0",
    "white-space:pre-wrap",
    "color:#c4d0db",
    "font-size:12px",
    "line-height:1.6"
  ].join(";");
  statsCard.body.append(stats);

  left.append(cowCard.root, statsCard.root);

  const right = document.createElement("div");
  right.style.cssText = "display:flex;flex-direction:column;min-height:0;";

  const logCard = makeCard("Event Log");
  logCard.root.style.height = "100%";
  const log = document.createElement("pre");
  log.setAttribute("data-testid", "event-log");
  log.style.cssText = [
    "margin:0",
    "white-space:pre-wrap",
    "color:#d7dee6",
    "font-size:11px",
    "line-height:1.5",
    "overflow:auto",
    "flex:1 1 auto"
  ].join(";");
  logCard.body.style.flex = "1 1 auto";
  logCard.body.append(log);
  right.append(logCard.root);

  content.append(left, right);
  wrapper.append(header, controls, hint, content);
  host.replaceChildren(wrapper);

  const emitSaid = () => {
    sentCount += 1;
    const payload = { text, visits, sentCount };
    pushLog({
      direction: "sent",
      type: "cowsay:said",
      source: String(context.paneId),
      scope: "tab",
      payload: JSON.stringify(payload),
      at: new Date().toISOString()
    });
    context.emit("cowsay:said", payload);
    sync();
  };

  const emitTitle = () => {
    lastTitle = `cowsay: ${text || "..."}`;
    pushLog({
      direction: "sent",
      type: "app:title",
      source: String(context.paneId),
      scope: "global",
      payload: JSON.stringify({ title: lastTitle }),
      at: new Date().toISOString()
    });
    context.emit("app:title", { title: lastTitle });
    sync();
  };

  const resetState = () => {
    text = "hello flmux";
    sentCount = 0;
    receivedCount = 0;
    visits = 1;
    lastMountedAt = new Date().toISOString();
    lastTitle = "cowsay lab";
    eventLog.length = 0;
    sync();
  };

  const clearLog = () => {
    eventLog.length = 0;
    sync();
  };

  const refreshHeaderActions = () => {
    const actions: HeaderAction[] = [
      {
        id: "emit-say",
        icon: "Moo",
        tooltip: "Emit cowsay:said in this tab",
        onClick: emitSaid
      },
      {
        id: "set-title",
        icon: "Title",
        tooltip: "Emit app:title",
        onClick: emitTitle
      },
      {
        id: "clear-log",
        icon: "Clear",
        tooltip: "Clear the event log",
        onClick: clearLog
      }
    ];
    context.setHeaderActions(actions);
  };

  const saidUnsub = context.on("cowsay:said", (event: PaneEvent) => {
    if (event.source === context.paneId) return;
    receivedCount += 1;
    pushLog({
      direction: "received",
      type: event.type,
      source: String(event.source),
      scope: "tab",
      payload: JSON.stringify(event.data),
      at: new Date(event.timestamp).toISOString()
    });
    sync();
  });

  const titleUnsub = context.on(
    "app:title",
    (event: PaneEvent) => {
      if (event.source === context.paneId) return;
      pushLog({
        direction: "received",
        type: event.type,
        source: String(event.source),
        scope: "global",
        payload: JSON.stringify(event.data),
        at: new Date(event.timestamp).toISOString()
      });
      sync();
    },
    { global: true }
  );

  input.addEventListener("input", () => {
    text = input.value;
    sync();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      emitSaid();
    }
  });
  sayBtn.addEventListener("click", emitSaid);
  titleBtn.addEventListener("click", emitTitle);
  resetBtn.addEventListener("click", resetState);
  clearBtn.addEventListener("click", clearLog);

  refreshHeaderActions();
  sync();

  return {
    dispose() {
      saidUnsub();
      titleUnsub();
      context.setHeaderActions([]);
      wrapper.remove();
    }
  };

  function sync(): void {
    input.value = text;
    cowOutput.textContent = renderCow(text);
    stats.textContent = [
      `text: ${JSON.stringify(text)}`,
      `visits: ${visits}`,
      `sentCount: ${sentCount}`,
      `receivedCount: ${receivedCount}`,
      `lastMountedAt: ${lastMountedAt}`,
      `lastTitle: ${JSON.stringify(lastTitle)}`,
      `savedLogEntries: ${eventLog.length}`
    ].join("\n");
    log.textContent = eventLog.length
      ? eventLog.map(formatLogEntry).join("\n")
      : "(no events yet)";
    context.setState({
      text,
      visits,
      sentCount,
      receivedCount,
      lastMountedAt,
      lastTitle,
      eventLog
    } satisfies CowsayState);
    refreshHeaderActions();
  }

  function pushLog(entry: EventLogEntry): void {
    eventLog.unshift(entry);
    if (eventLog.length > MAX_LOG_ENTRIES) {
      eventLog.length = MAX_LOG_ENTRIES;
    }
  }
};

function normalizeState(value: unknown): CowsayState {
  const fallback: CowsayState = {
    text: "",
    visits: 0,
    sentCount: 0,
    receivedCount: 0,
    lastMountedAt: "",
    lastTitle: "cowsay lab",
    eventLog: []
  };

  if (!value || typeof value !== "object") {
    return fallback;
  }

  const raw = value as Partial<CowsayState>;
  return {
    text: typeof raw.text === "string" ? raw.text : fallback.text,
    visits: typeof raw.visits === "number" ? raw.visits : fallback.visits,
    sentCount: typeof raw.sentCount === "number" ? raw.sentCount : fallback.sentCount,
    receivedCount: typeof raw.receivedCount === "number" ? raw.receivedCount : fallback.receivedCount,
    lastMountedAt: typeof raw.lastMountedAt === "string" ? raw.lastMountedAt : fallback.lastMountedAt,
    lastTitle: typeof raw.lastTitle === "string" ? raw.lastTitle : fallback.lastTitle,
    eventLog: Array.isArray(raw.eventLog)
      ? raw.eventLog
          .filter((entry): entry is EventLogEntry => !!entry && typeof entry === "object")
          .map((entry) => {
            const e = entry as Partial<EventLogEntry>;
            return {
              direction: e.direction === "received" ? "received" : "sent",
              type: typeof e.type === "string" ? e.type : "unknown",
              source: typeof e.source === "string" ? e.source : "unknown",
              scope: e.scope === "global" ? "global" : "tab",
              payload: typeof e.payload === "string" ? e.payload : "",
              at: typeof e.at === "string" ? e.at : ""
            };
          })
      : fallback.eventLog
  };
}

function renderCow(text: string): string {
  const safe = text.trim() || "...";
  const top = " " + "_".repeat(safe.length + 2);
  const mid = `< ${safe} >`;
  const bot = " " + "-".repeat(safe.length + 2);
  return [
    top,
    mid,
    bot,
    "        \\   ^__^",
    "         \\  (oo)\\_______",
    "            (__)\\       )\\/\\",
    "                ||----w |",
    "                ||     ||"
  ].join("\n");
}

function makeCard(label: string): { root: HTMLDivElement; body: HTMLDivElement } {
  const root = document.createElement("div");
  root.style.cssText = [
    "display:flex",
    "flex-direction:column",
    "gap:10px",
    "padding:12px",
    "border:1px solid rgba(255,255,255,0.08)",
    "background:rgba(0,0,0,0.18)",
    "border-radius:10px",
    "min-height:0"
  ].join(";");

  const title = document.createElement("div");
  title.textContent = label;
  title.style.cssText = "font-size:12px;font-weight:700;color:#9db0c3;text-transform:uppercase;";

  const body = document.createElement("div");
  body.style.cssText = "min-height:0;display:flex;flex-direction:column;";

  root.append(title, body);
  return { root, body };
}

function makeButton(label: string, color: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.style.cssText = [
    "padding:9px 12px",
    "border-radius:8px",
    "border:none",
    "cursor:pointer",
    "font:inherit",
    "font-size:12px",
    "font-weight:700",
    `background:${color}`,
    "color:#0b1016"
  ].join(";");
  return button;
}

function fieldStyle(): string {
  return [
    "width:100%",
    "padding:9px 11px",
    "border-radius:8px",
    "border:1px solid rgba(255,255,255,0.14)",
    "background:#0f141b",
    "color:#e8edf2",
    "font:inherit",
    "font-size:13px",
    "box-sizing:border-box"
  ].join(";");
}

function formatLogEntry(entry: EventLogEntry): string {
  const direction = entry.direction === "received" ? "in " : "out";
  return `[${direction}] [${entry.scope}] ${entry.type} from ${entry.source} @ ${entry.at}\n${entry.payload}`;
}
