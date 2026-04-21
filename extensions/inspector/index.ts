import type {
  ExtensionPaneContext,
  ExtensionDefinition,
  ExtensionPaneInstance,
  ShellPathGetResult,
  ShellPathListResult
} from "@flmux/extension-api";
import { defineExtension, definePane } from "@flmux/extension-api";

interface SnapshotState {
  appTitle: string;
  workspaceTitle: string;
  workspaceId: string;
  activePaneId: string;
  paneCount: number;
  paneNames: string[];
  subscription: string;
}

interface EventLogEntry {
  topic: string;
  payload: unknown;
  timestamp: number;
}

class InspectorPaneRenderer implements ExtensionPaneInstance {
  private unsubscribeBus?: () => void;
  private snapshot: SnapshotState = {
    appTitle: "loading",
    workspaceTitle: "loading",
    workspaceId: "",
    activePaneId: "none",
    paneCount: 0,
    paneNames: [],
    subscription: "*"
  };
  private eventLog: EventLogEntry[] = [];

  private appTitleEl?: HTMLElement;
  private workspaceTitleEl?: HTMLElement;
  private workspaceIdEl?: HTMLElement;
  private paneIdEl?: HTMLElement;
  private activePaneEl?: HTMLElement;
  private paneCountEl?: HTMLElement;
  private paneListEl?: HTMLElement;
  private lastEventEl?: HTMLElement;
  private eventListEl?: HTMLElement;
  private subscriptionEl?: HTMLElement;
  private refreshButton?: HTMLButtonElement;
  private pingButton?: HTMLButtonElement;

  constructor(
    private readonly host: HTMLElement,
    private readonly context: ExtensionPaneContext
  ) {
    this.host.className = "inspector-panel";
    this.mount();
  }

  dispose() {
    this.unsubscribeBus?.();
  }

  private mount() {
    this.host.innerHTML = `
      <section class="inspector-hero">
        <div>
          <strong>external inspector</strong>
          <p>Minimal external pane using shell read model and workspace bus.</p>
        </div>
        <div class="inspector-identities">
          <span data-role="workspace-id">workspace</span>
          <span data-role="pane-id">pane</span>
        </div>
      </section>
      <div class="inspector-grid">
        <section class="inspector-card">
          <header class="inspector-card__header">
            <strong>Snapshot</strong>
            <span>Reads current shell status via external runtime contract.</span>
          </header>
          <dl class="inspector-stats">
            <div>
              <dt>App</dt>
              <dd data-role="app-title">loading</dd>
            </div>
            <div>
              <dt>Workspace</dt>
              <dd data-role="workspace-title">loading</dd>
            </div>
            <div>
              <dt>Active Pane</dt>
              <dd data-role="active-pane">none</dd>
            </div>
            <div>
              <dt>Pane Count</dt>
              <dd data-role="pane-count">0</dd>
            </div>
            <div>
              <dt>Last Event</dt>
              <dd data-role="last-event">none</dd>
            </div>
          </dl>
          <div class="inspector-pane-list" data-role="pane-list"></div>
          <div class="inspector-actions">
            <button type="button" data-action="refresh">Refresh</button>
            <button type="button" data-action="ping">Ping Bus</button>
          </div>
        </section>
        <section class="inspector-card inspector-card--events">
          <header class="inspector-card__header">
            <strong>Events</strong>
            <span>Subscribed to <code data-role="subscription">*</code> within the current workspace.</span>
          </header>
          <div class="inspector-log" data-role="event-list"></div>
        </section>
      </div>
    `;

    this.appTitleEl = this.host.querySelector<HTMLElement>('[data-role="app-title"]')!;
    this.workspaceTitleEl = this.host.querySelector<HTMLElement>('[data-role="workspace-title"]')!;
    this.workspaceIdEl = this.host.querySelector<HTMLElement>('[data-role="workspace-id"]')!;
    this.paneIdEl = this.host.querySelector<HTMLElement>('[data-role="pane-id"]')!;
    this.activePaneEl = this.host.querySelector<HTMLElement>('[data-role="active-pane"]')!;
    this.paneCountEl = this.host.querySelector<HTMLElement>('[data-role="pane-count"]')!;
    this.paneListEl = this.host.querySelector<HTMLElement>('[data-role="pane-list"]')!;
    this.lastEventEl = this.host.querySelector<HTMLElement>('[data-role="last-event"]')!;
    this.eventListEl = this.host.querySelector<HTMLElement>('[data-role="event-list"]')!;
    this.subscriptionEl = this.host.querySelector<HTMLElement>('[data-role="subscription"]')!;
    this.refreshButton = this.host.querySelector<HTMLButtonElement>('[data-action="refresh"]')!;
    this.pingButton = this.host.querySelector<HTMLButtonElement>('[data-action="ping"]')!;

    this.paneIdEl.textContent = this.context.paneId;
    this.workspaceIdEl.textContent = this.context.workspaceId;
    this.refreshButton.addEventListener("click", () => {
      void this.refreshSnapshot();
    });
    this.pingButton.addEventListener("click", () => {
      void this.publishPing();
    });

    this.unsubscribeBus = this.context.bus.subscribe(this.readSubscription(), (event) => {
      this.eventLog.unshift({
        topic: event.topic,
        payload: event.payload,
        timestamp: event.timestamp
      });
      this.eventLog = this.eventLog.slice(0, 12);
      this.lastEventEl!.textContent = event.topic;
      this.renderEventLog();
    });

    void this.refreshSnapshot();
  }

  private async refreshSnapshot() {
    const [appResult, workspaceResult, panesResult] = await Promise.all([
      this.context.shell.get("/status/app"),
      this.context.shell.get("/status/workspace"),
      this.context.shell.list("/status/panes")
    ]);

    this.snapshot = {
      appTitle: readAppTitle(appResult) ?? "unavailable",
      workspaceTitle: readWorkspaceTitle(workspaceResult) ?? "unavailable",
      workspaceId: readWorkspaceId(workspaceResult) ?? this.context.workspaceId,
      activePaneId: readActivePaneId(workspaceResult) ?? "none",
      paneCount: readPaneCount(panesResult),
      paneNames: readPaneNames(panesResult),
      subscription: this.readSubscription()
    };
    this.renderSnapshot();
  }

  private async publishPing() {
    await this.context.bus.publish("inspector.ping", {
      paneId: this.context.paneId,
      workspaceId: this.context.workspaceId
    });
  }

  private renderSnapshot() {
    this.appTitleEl!.textContent = this.snapshot.appTitle;
    this.workspaceTitleEl!.textContent = this.snapshot.workspaceTitle;
    this.workspaceIdEl!.textContent = this.snapshot.workspaceId;
    this.activePaneEl!.textContent = this.snapshot.activePaneId;
    this.paneCountEl!.textContent = `${this.snapshot.paneCount} panes`;
    this.subscriptionEl!.textContent = this.snapshot.subscription;
    this.paneListEl!.replaceChildren(
      ...this.snapshot.paneNames.map((name) => {
        const item = document.createElement("span");
        item.className = "inspector-pane-list__item";
        item.textContent = name;
        return item;
      })
    );
  }

  private readSubscription() {
    const params = this.context.state.getParams<{ subscription?: string }>();
    return typeof params.subscription === "string" && params.subscription.length > 0 ? params.subscription : "*";
  }

  private renderEventLog() {
    this.eventListEl!.replaceChildren(
      ...this.eventLog.map((entry) => {
        const article = document.createElement("article");
        article.className = "inspector-log__entry";
        const meta = document.createElement("div");
        meta.className = "inspector-log__meta";
        meta.textContent = `${formatTime(entry.timestamp)}  ${entry.topic}`;
        const body = document.createElement("pre");
        body.className = "inspector-log__body";
        body.textContent = formatPayload(entry.payload);
        article.append(meta, body);
        return article;
      })
    );
  }
}

const inspectorPane = definePane({
  kind: "inspector",
  mount: (host, context) => new InspectorPaneRenderer(host, context),
  createParams: ({ input }) => ({
    subscription:
      typeof input.params?.subscription === "string" && input.params.subscription.length > 0
        ? input.params.subscription
        : "*"
  }),
  getTitle: ({ input }) => input.title?.trim() || "Inspector",
  normalizeRestoredParams: ({ params }) => ({
    subscription: typeof params?.subscription === "string" && params.subscription.length > 0 ? params.subscription : "*"
  }),
  serializeParams: ({ currentParams }) => ({
    subscription:
      typeof currentParams?.subscription === "string" && currentParams.subscription.length > 0
        ? currentParams.subscription
        : "*"
  }),
  pathMount: {
    mountKey: "inspector",
    getStateSnapshot: ({ currentParams }) => ({
      subscription:
        typeof currentParams?.subscription === "string" && currentParams.subscription.length > 0
          ? currentParams.subscription
          : "*"
    }),
    getStatusSnapshot: ({ workspaceId, defaultBrowserPath }) => ({
      workspaceId,
      defaultBrowserPath
    })
  }
});

export default defineExtension({
  panes: [inspectorPane]
} satisfies ExtensionDefinition);

function readAppTitle(result: ShellPathGetResult) {
  return result.ok && result.found && isRecord(result.value) && typeof result.value.title === "string"
    ? result.value.title
    : null;
}

function readWorkspaceTitle(result: ShellPathGetResult) {
  return result.ok && result.found && isRecord(result.value) && typeof result.value.title === "string"
    ? result.value.title
    : null;
}

function readWorkspaceId(result: ShellPathGetResult) {
  return result.ok && result.found && isRecord(result.value) && typeof result.value.id === "string"
    ? result.value.id
    : null;
}

function readActivePaneId(result: ShellPathGetResult) {
  return result.ok && result.found && isRecord(result.value) && typeof result.value.activePaneId === "string"
    ? result.value.activePaneId
    : null;
}

function readPaneCount(result: ShellPathListResult) {
  return result.ok && result.found ? result.entries.length : 0;
}

function readPaneNames(result: ShellPathListResult) {
  return result.ok && result.found ? result.entries.map((entry) => entry.name) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function formatPayload(payload: unknown) {
  return typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}
