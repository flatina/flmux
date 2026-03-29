import { defineView, parseViewKey, type HeaderAction } from "flmux-sdk";

interface EventLogEntry {
  direction: "sent" | "received";
  type: string;
  source: string;
  scope: "tab" | "global" | "app" | "workspace" | "pane";
  payload: string;
  at: string;
}

interface CowsayState {
  text: string;
  visits: number;
  sentCount: number;
  receivedCount: number;
  lastMountedAt: string;
  appTitle: string;
  workspaceTitle: string;
  paneTitle: string;
  eventLog: EventLogEntry[];
}

const MAX_LOG_ENTRIES = 40;

export default defineView<Record<string, never>, CowsayState>({
  createInstance(context) {
    const state = normalizeState(context.state);
    const isFirstMount = state.visits === 0;
    let text = state.text || "hello flmux";
    let visits = state.visits + 1;
    let sentCount = state.sentCount;
    let receivedCount = state.receivedCount;
    let appTitle = state.appTitle;
    let workspaceTitle = state.workspaceTitle;
    let paneTitle = state.paneTitle;
    let lastMountedAt = new Date().toISOString();
    const eventLog = [...state.eventLog];

    let host: HTMLElement | null = null;
    let input: HTMLInputElement | null = null;
    let cowOutput: HTMLElement | null = null;
    let stats: HTMLElement | null = null;
    let log: HTMLElement | null = null;

    const emitSaid = () => {
      sentCount += 1;
      const payload = { text, visits, sentCount };
      const meta = {
        sourcePaneId: context.paneId,
        tabId: context.tabId,
        timestamp: Date.now()
      };
      pushLog({
        direction: "sent",
        type: "cowsay:said",
        source: String(context.paneId),
        scope: "tab",
        payload: JSON.stringify(payload),
        at: new Date().toISOString()
      });
      context.curWorkspace.emit("cowsay:said", payload, meta);
      sync();
    };

    const formatScopedTitle = (scope: "app" | "workspace" | "pane") => `${scope}:${text.trim() || "..."}`;

    const applyScopedTitle = (scope: "app" | "workspace" | "pane") => {
      const title = formatScopedTitle(scope);
      if (scope === "app") {
        context.app.title = title;
        appTitle = title;
      } else if (scope === "workspace") {
        context.curWorkspace.title = title;
        workspaceTitle = title;
      } else {
        context.curPane.title = title;
        paneTitle = title;
      }
      pushLog({
        direction: "sent",
        type: `${scope}:title.set`,
        source: String(context.paneId),
        scope,
        payload: JSON.stringify({ title }),
        at: new Date().toISOString()
      });
      sync();
    };

    const resetState = () => {
      text = "hello flmux";
      sentCount = 0;
      receivedCount = 0;
      visits = 1;
      lastMountedAt = new Date().toISOString();
      appTitle = "";
      workspaceTitle = "";
      paneTitle = "";
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
          id: "set-app-title",
          icon: "App",
          tooltip: "Set app title property",
          onClick: () => applyScopedTitle("app")
        },
        {
          id: "set-workspace-title",
          icon: "Workspace",
          tooltip: "Set workspace title property",
          onClick: () => applyScopedTitle("workspace")
        },
        {
          id: "set-pane-title",
          icon: "Pane",
          tooltip: "Set pane title property",
          onClick: () => applyScopedTitle("pane")
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

    const saidUnsub = context.curWorkspace.on("cowsay:said", (payload, meta) => {
      const eventMeta = meta as { sourcePaneId?: unknown; timestamp?: unknown };
      if (eventMeta.sourcePaneId === context.paneId) return;
      receivedCount += 1;
      pushLog({
        direction: "received",
        type: "cowsay:said",
        source: String(eventMeta.sourcePaneId ?? "unknown"),
        scope: "tab",
        payload: JSON.stringify(payload),
        at: new Date(typeof eventMeta.timestamp === "number" ? eventMeta.timestamp : Date.now()).toISOString()
      });
      sync();
    });

    const appTitleUnsub = context.app.on("change:title", (value) => {
      appTitle = String(value ?? "");
      sync();
    });

    const workspaceTitleUnsub = context.curWorkspace.on("change:title", (value) => {
      workspaceTitle = String(value ?? "");
      sync();
    });

    const paneTitleUnsub = context.curPane.on("change:title", (value) => {
      paneTitle = String(value ?? "");
      sync();
    });

    const titleCommandUnsub = context.app.on("cowsay:titles", (payload) => {
        const data = payload as {
          appTitle?: unknown;
          workspaceTitle?: unknown;
          paneTitle?: unknown;
        };
        if (typeof data.appTitle === "string") {
          context.app.title = data.appTitle;
        }
        if (typeof data.workspaceTitle === "string") {
          context.curWorkspace.title = data.workspaceTitle;
        }
        if (typeof data.paneTitle === "string") {
          context.curPane.title = data.paneTitle;
        }
      });

    return {
      async mount(nextHost) {
        host = nextHost;
        host.innerHTML = await context.loadAssetText("./index.html");

        const paneId = mustQuery(host, "[data-ref='pane-id']");
        const tabId = mustQuery(host, "[data-ref='tab-id']");
        const extId = mustQuery(host, "[data-ref='ext-id']");
        input = mustQuery(host, "[data-ref='input']") as HTMLInputElement;
        const sayBtn = mustQuery(host, "[data-ref='say-btn']");
        const appTitleBtn = mustQuery(host, "[data-ref='app-title-btn']");
        const workspaceTitleBtn = mustQuery(host, "[data-ref='workspace-title-btn']");
        const paneTitleBtn = mustQuery(host, "[data-ref='pane-title-btn']");
        const resetBtn = mustQuery(host, "[data-ref='reset-btn']");
        const clearBtn = mustQuery(host, "[data-ref='clear-btn']");
        cowOutput = mustQuery(host, "[data-ref='cow-output']");
        stats = mustQuery(host, "[data-ref='stats']");
        log = mustQuery(host, "[data-ref='event-log']");

        paneId.textContent = String(context.paneId);
        tabId.textContent = String(context.tabId);
        const view = parseViewKey(context.viewKey);
        extId.textContent = view ? `${view.extensionId}/${view.viewId}` : context.viewKey;

        input.addEventListener("input", () => {
          text = input?.value ?? text;
          sync();
        });
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            emitSaid();
          }
        });
        sayBtn.addEventListener("click", emitSaid);
        appTitleBtn.addEventListener("click", () => applyScopedTitle("app"));
        workspaceTitleBtn.addEventListener("click", () => applyScopedTitle("workspace"));
        paneTitleBtn.addEventListener("click", () => applyScopedTitle("pane"));
        resetBtn.addEventListener("click", resetState);
        clearBtn.addEventListener("click", clearLog);

        if (isFirstMount) {
          context.app.title = formatScopedTitle("app");
          context.curWorkspace.title = formatScopedTitle("workspace");
          context.curPane.title = formatScopedTitle("pane");
        }

        refreshHeaderActions();
        sync();
      },
      dispose() {
        saidUnsub();
        appTitleUnsub();
        workspaceTitleUnsub();
        paneTitleUnsub();
        titleCommandUnsub();
        context.setHeaderActions([]);
        host?.replaceChildren();
        host = null;
      }
    };

    function sync(): void {
      if (!input || !cowOutput || !stats || !log) {
        return;
      }
      input.value = text;
      cowOutput.textContent = renderCow(text);
      stats.textContent = [
        `text: ${JSON.stringify(text)}`,
        `visits: ${visits}`,
        `sentCount: ${sentCount}`,
        `receivedCount: ${receivedCount}`,
        `lastMountedAt: ${lastMountedAt}`,
        `appTitle: ${JSON.stringify(appTitle)}`,
        `workspaceTitle: ${JSON.stringify(workspaceTitle)}`,
        `paneTitle: ${JSON.stringify(paneTitle)}`,
        `savedLogEntries: ${eventLog.length}`
      ].join("\n");
      log.textContent = eventLog.length ? eventLog.map(formatLogEntry).join("\n") : "(no events yet)";
      context.setState({
        text,
        visits,
        sentCount,
        receivedCount,
        lastMountedAt,
        appTitle,
        workspaceTitle,
        paneTitle,
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
  }
});

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
    appTitle: "",
    workspaceTitle: "",
    paneTitle: "",
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
    appTitle: typeof raw.appTitle === "string" ? raw.appTitle : fallback.appTitle,
    workspaceTitle: typeof raw.workspaceTitle === "string" ? raw.workspaceTitle : fallback.workspaceTitle,
    paneTitle: typeof raw.paneTitle === "string" ? raw.paneTitle : fallback.paneTitle,
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
