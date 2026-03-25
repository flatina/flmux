import type { ExtensionMount, HeaderAction, PaneEvent } from "../../src/shared/extension-spi";

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

export const mount: ExtensionMount = async (host, context) => {
  const state = normalizeState(context.initialState);
  let text = state.text || "hello flmux";
  let visits = state.visits + 1;
  let sentCount = state.sentCount;
  let receivedCount = state.receivedCount;
  let lastTitle = state.lastTitle || "cowsay lab";
  let lastMountedAt = new Date().toISOString();
  const eventLog = [...state.eventLog];

  host.innerHTML = await context.loadAssetText("./index.html");

  const paneId = mustQuery(host, "[data-ref='pane-id']");
  const tabId = mustQuery(host, "[data-ref='tab-id']");
  const extId = mustQuery(host, "[data-ref='ext-id']");
  const input = mustQuery(host, "[data-ref='input']") as HTMLInputElement;
  const sayBtn = mustQuery(host, "[data-ref='say-btn']");
  const titleBtn = mustQuery(host, "[data-ref='title-btn']");
  const resetBtn = mustQuery(host, "[data-ref='reset-btn']");
  const clearBtn = mustQuery(host, "[data-ref='clear-btn']");
  const cowOutput = mustQuery(host, "[data-ref='cow-output']");
  const stats = mustQuery(host, "[data-ref='stats']");
  const log = mustQuery(host, "[data-ref='event-log']");

  paneId.textContent = String(context.paneId);
  tabId.textContent = String(context.tabId);
  extId.textContent = `${context.extensionId}/${context.contributionId}`;

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
      host.replaceChildren();
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
    log.textContent = eventLog.length ? eventLog.map(formatLogEntry).join("\n") : "(no events yet)";
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

function mustQuery(root: ParentNode, selector: string): HTMLElement {
  const element = root.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing cowsay asset node: ${selector}`);
  }
  return element;
}

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
  const top = ` ${"_".repeat(safe.length + 2)}`;
  const mid = `< ${safe} >`;
  const bot = ` ${"-".repeat(safe.length + 2)}`;
  return [
    top,
    mid,
    bot,
    "        \\\\   ^__^",
    "         \\\\  (oo)\\\\_______",
    "            (__)\\\\       )\\\\/\\\\",
    "                ||----w |",
    "                ||     ||"
  ].join("\n");
}

function formatLogEntry(entry: EventLogEntry): string {
  const direction = entry.direction === "received" ? "in " : "out";
  return `[${direction}] [${entry.scope}] ${entry.type} from ${entry.source} @ ${entry.at}\n${entry.payload}`;
}
