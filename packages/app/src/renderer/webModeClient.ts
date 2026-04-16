import type {
  PathCallResult,
  PathGetResult,
  PathListResult,
  PathSetResult
} from "./shell/types";
import type { FlmuxRendererBootstrapConfig } from "../shared/rendererBridge";

type RemoteShellModelAPI = {
  pathGet(path: string): Promise<PathGetResult>;
  pathList(path: string): Promise<PathListResult>;
  pathSet(path: string, value: unknown): Promise<PathSetResult>;
  pathCall(path: string, args?: Record<string, unknown>): Promise<PathCallResult>;
};

type LogKind = "input" | "result" | "error" | "system";

interface LogEntry {
  kind: LogKind;
  message: string;
  timestamp: number;
  value?: unknown;
}

interface AppStatusSnapshot {
  title: string;
  origin: string;
  runtimeLabel: string;
}

interface WorkspaceStatusSnapshot {
  id: string;
  title: string;
  activePaneId: string | null;
  paneCount: number;
}

interface PaneStatusSnapshot {
  id: string;
  kind: string;
  title: string;
  active: boolean;
  browser?: {
    url: string;
  };
  terminal?: {
    attached: boolean;
    cwd: string;
    rootKey: string | null;
    runtimeId: string | null;
    alive: boolean | null;
  };
}

export class FlmuxWebModeClient {
  private readonly shell: RemoteShellModelAPI;
  private readonly refreshIntervalMs = 2_000;
  private readonly logs: LogEntry[] = [];

  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private appTitleEl?: HTMLElement;
  private workspaceTitleEl?: HTMLElement;
  private runtimeBadgeEl?: HTMLElement;
  private workspaceSwitcherEl?: HTMLElement;
  private paneListEl?: HTMLElement;
  private replFormEl?: HTMLFormElement;
  private replInputEl?: HTMLInputElement;
  private logListEl?: HTMLElement;
  private statusNoteEl?: HTMLElement;

  constructor(private readonly config: FlmuxRendererBootstrapConfig) {
    if (!config.authorityClientId) {
      throw new Error("Web mode renderer requires a server authority client id");
    }

    this.shell = createRemoteShellModel({
      origin: config.appOrigin,
      clientId: config.authorityClientId
    });
  }

  async start() {
    this.renderLayout();
    this.bindActions();
    await this.refresh();
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, this.refreshIntervalMs);
  }

  private renderLayout() {
    const app = document.getElementById("app");
    if (!app) {
      throw new Error("Missing #app root");
    }

    app.innerHTML = `
      <header class="topbar">
        <div class="topbar__titles">
          <strong id="app-title">flmux</strong>
          <span class="workspace-title" id="workspace-title">web attach</span>
        </div>
        <span class="runtime-badge" id="runtime-badge">server authority</span>
        <div class="workspace-switcher" id="workspace-switcher" aria-label="Workspace Switcher"></div>
        <button data-action="refresh">Refresh</button>
        <button data-action="new-workspace">+ Workspace</button>
        <button data-action="new-browser">+ Browser</button>
        <button data-action="new-terminal">+ Terminal</button>
      </header>
      <main class="web-mode-shell">
        <section class="web-mode-card web-mode-card--summary">
          <header class="web-mode-card__header">
            <strong>Attached Session</strong>
            <span data-role="status-note">Projecting the server-owned shell authority.</span>
          </header>
          <div class="web-mode-pane-list" data-role="pane-list"></div>
        </section>
        <section class="web-mode-card web-mode-card--repl">
          <header class="web-mode-card__header">
            <strong>Path REPL</strong>
            <span>Runs against the server authority via HTTP path APIs.</span>
          </header>
          <form class="web-mode-repl" data-role="repl-form">
            <input class="web-mode-repl__input" type="text" data-role="repl-input" spellcheck="false" placeholder="get /status/workspace" />
            <button type="submit">Run</button>
          </form>
          <div class="web-mode-examples">
            <button type="button" data-example="get /status/workspace">workspace</button>
            <button type="button" data-example="get /status/panes">panes</button>
            <button type="button" data-example="call /panes/new kind=browser url=/__flmux/internal/start?workspace=workspace.1">new browser</button>
            <button type="button" data-example="call /panes/new kind=terminal cwd=.">new terminal</button>
          </div>
          <div class="web-mode-log" data-role="log-list"></div>
        </section>
      </main>
    `;

    this.appTitleEl = document.getElementById("app-title")!;
    this.workspaceTitleEl = document.getElementById("workspace-title")!;
    this.runtimeBadgeEl = document.getElementById("runtime-badge")!;
    this.workspaceSwitcherEl = document.getElementById("workspace-switcher")!;
    this.paneListEl = app.querySelector<HTMLElement>('[data-role="pane-list"]')!;
    this.replFormEl = app.querySelector<HTMLFormElement>('[data-role="repl-form"]')!;
    this.replInputEl = app.querySelector<HTMLInputElement>('[data-role="repl-input"]')!;
    this.logListEl = app.querySelector<HTMLElement>('[data-role="log-list"]')!;
    this.statusNoteEl = app.querySelector<HTMLElement>('[data-role="status-note"]')!;
  }

  private bindActions() {
    document.querySelector<HTMLButtonElement>('[data-action="refresh"]')?.addEventListener("click", () => {
      void this.refresh();
    });
    document.querySelector<HTMLButtonElement>('[data-action="new-workspace"]')?.addEventListener("click", () => {
      void this.runPathCall("/workspaces/new");
    });
    document.querySelector<HTMLButtonElement>('[data-action="new-browser"]')?.addEventListener("click", () => {
      void this.runPathCall("/panes/new", {
        kind: "browser",
        place: "right"
      });
    });
    document.querySelector<HTMLButtonElement>('[data-action="new-terminal"]')?.addEventListener("click", () => {
      void this.runPathCall("/panes/new", {
        kind: "terminal",
        cwd: ".",
        place: "right"
      });
    });

    this.replFormEl?.addEventListener("submit", (event) => {
      event.preventDefault();
      const command = this.replInputEl?.value.trim() ?? "";
      if (!command) {
        return;
      }
      this.replInputEl!.value = "";
      void this.runCommand(command);
    });

    document.querySelectorAll<HTMLButtonElement>(".web-mode-examples button").forEach((button) => {
      button.addEventListener("click", () => {
        const example = button.dataset.example ?? "";
        if (!this.replInputEl) {
          return;
        }
        this.replInputEl.value = example;
        this.replInputEl.focus();
      });
    });
  }

  private async refresh() {
    const [appResult, currentWorkspaceResult, workspacesResult, panesResult] = await Promise.all([
      this.shell.pathGet("/status/app"),
      this.shell.pathGet("/status/workspace"),
      this.shell.pathGet("/workspaces"),
      this.shell.pathGet("/status/panes")
    ]);

    const appStatus = readFoundValue<AppStatusSnapshot>(appResult);
    const currentWorkspace = readFoundValue<WorkspaceStatusSnapshot>(currentWorkspaceResult);
    const workspaces = Object.values(readFoundValue<Record<string, WorkspaceStatusSnapshot>>(workspacesResult) ?? {});
    const panes = Object.values(readFoundValue<Record<string, PaneStatusSnapshot>>(panesResult) ?? {});

    if (appStatus) {
      this.appTitleEl!.textContent = appStatus.title;
      this.runtimeBadgeEl!.textContent = appStatus.runtimeLabel;
    }

    if (currentWorkspace) {
      this.workspaceTitleEl!.textContent = `${currentWorkspace.title} · ${currentWorkspace.id} · ${currentWorkspace.paneCount} panes`;
      document.title = `${appStatus?.title ?? "flmux"} / ${currentWorkspace.title}`;
    }

    this.statusNoteEl!.textContent = `Server authority client: ${this.config.authorityClientId}`;
    this.renderWorkspaceChips(workspaces, currentWorkspace?.id ?? null);
    this.renderPaneCards(panes);
  }

  private renderWorkspaceChips(workspaces: WorkspaceStatusSnapshot[], activeWorkspaceId: string | null) {
    this.workspaceSwitcherEl?.replaceChildren(
      ...workspaces.map((workspace) => {
        const chip = document.createElement("span");
        chip.className = "workspace-chip";
        chip.dataset.active = String(workspace.id === activeWorkspaceId);
        chip.textContent = workspace.id === activeWorkspaceId
          ? `${workspace.title} (${workspace.paneCount})`
          : `${workspace.title}`;
        return chip;
      })
    );
  }

  private renderPaneCards(panes: PaneStatusSnapshot[]) {
    this.paneListEl?.replaceChildren(
      ...panes.map((pane) => {
        const card = document.createElement("article");
        card.className = "web-mode-pane";

        const title = document.createElement("div");
        title.className = "web-mode-pane__title";
        title.textContent = `${pane.title} · ${pane.kind}${pane.active ? " · active" : ""}`;

        const meta = document.createElement("pre");
        meta.className = "web-mode-pane__meta";
        meta.textContent = formatPaneMeta(pane);

        const actions = document.createElement("div");
        actions.className = "web-mode-pane__actions";

        const closeButton = document.createElement("button");
        closeButton.type = "button";
        closeButton.textContent = "Close";
        closeButton.addEventListener("click", () => {
          void this.runPathCall(`/panes/${pane.id}/close`);
        });
        actions.append(closeButton);

        if (pane.kind === "terminal") {
          const terminalAction = document.createElement("button");
          terminalAction.type = "button";
          terminalAction.textContent = pane.terminal?.attached ? "Kill Runtime" : "Create Runtime";
          terminalAction.addEventListener("click", () => {
            void this.runPathCall(
              pane.terminal?.attached
                ? `/panes/${pane.id}/terminal/kill`
                : `/panes/${pane.id}/terminal/create`,
              pane.terminal?.attached ? undefined : { cwd: "." }
            );
          });
          actions.append(terminalAction);
        }

        card.append(title, meta, actions);
        return card;
      })
    );
  }

  private async runPathCall(path: string, args?: Record<string, unknown>) {
    const result = await this.shell.pathCall(path, args);
    this.pushLog("result", `call ${path}`, result);
    await this.refresh();
  }

  private async runCommand(command: string) {
    this.pushLog("input", command);
    try {
      const result = await executeCommand(this.shell, command);
      this.pushLog("result", command, result);
      await this.refresh();
    } catch (error) {
      this.pushLog("error", error instanceof Error ? error.message : String(error));
    }
  }

  private pushLog(kind: LogKind, message: string, value?: unknown) {
    this.logs.unshift({
      kind,
      message,
      value,
      timestamp: Date.now()
    });
    this.logs.splice(16);
    this.renderLogs();
  }

  private renderLogs() {
    this.logListEl?.replaceChildren(
      ...this.logs.map((entry) => {
        const card = document.createElement("article");
        card.className = `web-mode-log__entry web-mode-log__entry--${entry.kind}`;
        const meta = document.createElement("div");
        meta.className = "web-mode-log__meta";
        meta.textContent = `${formatTime(entry.timestamp)}  ${entry.kind}`;
        const body = document.createElement("pre");
        body.className = "web-mode-log__body";
        body.textContent = entry.value === undefined
          ? entry.message
          : `${entry.message}\n${JSON.stringify(entry.value, null, 2)}`;
        card.append(meta, body);
        return card;
      })
    );
  }
}

function createRemoteShellModel(options: {
  origin: string;
  clientId: string;
}): RemoteShellModelAPI {
  async function post<T>(pathname: string, payload: Record<string, unknown>) {
    const response = await fetch(`${options.origin}${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        clientId: options.clientId,
        ...payload
      })
    });
    if (!response.ok) {
      throw new Error(`${pathname} failed: ${response.status} ${response.statusText}`);
    }

    const body = await response.json() as { ok: boolean; result?: T; error?: string };
    if (!body.ok || body.result === undefined) {
      throw new Error(body.error ?? `Request failed: ${pathname}`);
    }
    return body.result;
  }

  return {
    pathGet(path) {
      return post<PathGetResult>("/api/model/path/get", { path });
    },
    pathList(path) {
      return post<PathListResult>("/api/model/path/list", { path });
    },
    pathSet(path, value) {
      return post<PathSetResult>("/api/model/path/set", { path, value });
    },
    pathCall(path, args) {
      return post<PathCallResult>("/api/model/path/call", { path, args });
    }
  };
}

async function executeCommand(shell: RemoteShellModelAPI, command: string) {
  const tokens = tokenize(command);
  if (tokens.length === 0) {
    return null;
  }

  const [verb, ...rest] = tokens;
  switch (verb) {
    case "get":
      return await shell.pathGet(requireToken(rest[0], "get <path> requires a path"));
    case "ls":
      return await shell.pathList(requireToken(rest[0], "ls <path> requires a path"));
    case "set": {
      const path = requireToken(rest[0], "set <path> <value> requires a path");
      return await shell.pathSet(path, coerceScalar(rest.slice(1).join(" ")));
    }
    case "call": {
      const path = requireToken(rest[0], "call <path> requires a path");
      return await shell.pathCall(path, parseNamedArgs(rest.slice(1)));
    }
    default:
      throw new Error(`Unknown command '${verb}'`);
  }
}

function parseNamedArgs(tokens: string[]) {
  return Object.fromEntries(
    tokens.map((token) => {
      const equalsIndex = token.indexOf("=");
      if (equalsIndex <= 0) {
        throw new Error("call only accepts key=value arguments");
      }
      return [token.slice(0, equalsIndex), coerceScalar(token.slice(equalsIndex + 1))];
    })
  );
}

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of command.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (quote) {
    throw new Error("Unterminated quoted string");
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function requireToken(token: string | undefined, message: string) {
  if (!token) {
    throw new Error(message);
  }
  return token;
}

function coerceScalar(rawValue: string): unknown {
  if (rawValue === "true") return true;
  if (rawValue === "false") return false;
  if (rawValue === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(rawValue)) return Number(rawValue);
  return rawValue;
}

function readFoundValue<T>(result: PathGetResult): T | null {
  return result.ok && result.found ? result.value as T : null;
}

function formatPaneMeta(pane: PaneStatusSnapshot) {
  if (pane.kind === "browser") {
    return JSON.stringify({
      id: pane.id,
      url: pane.browser?.url ?? ""
    }, null, 2);
  }

  if (pane.kind === "terminal") {
    return JSON.stringify({
      id: pane.id,
      attached: pane.terminal?.attached ?? false,
      cwd: pane.terminal?.cwd ?? "",
      runtimeId: pane.terminal?.runtimeId ?? null,
      rootKey: pane.terminal?.rootKey ?? null,
      alive: pane.terminal?.alive ?? null
    }, null, 2);
  }

  return JSON.stringify({
    id: pane.id,
    kind: pane.kind
  }, null, 2);
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}
