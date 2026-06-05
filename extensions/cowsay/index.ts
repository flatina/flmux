import type { ExtensionPaneContext, ExtensionPaneInstance } from "@flmux/extension-api";
import { defineExtension, definePaneRenderer } from "@flmux/extension-api";
import { type OutputMode, ensureStylesheet, formatTime, formatValue, parser, unwrapValue } from "./helpers";

type LogKind = "input" | "result" | "error" | "event" | "system";

interface LogEntry {
  kind: LogKind;
  message: string;
  value?: unknown;
  timestamp: number;
}

const panelTemplateUrl = new URL("./panel.html", import.meta.url).href;
const panelStylesheetUrl = new URL("./panel.css", import.meta.url).href;
const STYLESHEET_ID = "cowsay-panel-styles";

class CowsayPaneRenderer implements ExtensionPaneInstance {
  private outputMode: OutputMode = "pretty";
  private subscription = "*";
  private unsubscribeBus?: () => void;
  private logs: LogEntry[] = [];
  private disposed = false;

  private commandForm?: HTMLFormElement;
  private commandInput?: HTMLInputElement;
  private subscriptionForm?: HTMLFormElement;
  private subscriptionInput?: HTMLInputElement;
  private outputSelect?: HTMLSelectElement;
  private logList?: HTMLElement;

  constructor(
    private readonly host: HTMLElement,
    private readonly context: ExtensionPaneContext
  ) {
    this.host.classList.add("cowsay-panel");
    ensureStylesheet(STYLESHEET_ID, panelStylesheetUrl);
    void this.mount();
  }

  dispose() {
    this.disposed = true;
    this.unsubscribeBus?.();
  }

  private async mount() {
    let html: string;
    try {
      html = await fetch(panelTemplateUrl).then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      });
    } catch (error) {
      console.warn("[cowsay] panel template fetch failed", error);
      if (!this.disposed) this.host.textContent = "(panel template failed to load)";
      return;
    }
    if (this.disposed) return;

    this.host.innerHTML = html;

    this.commandForm = this.host.querySelector<HTMLFormElement>('[data-role="command-form"]')!;
    this.commandInput = this.host.querySelector<HTMLInputElement>(".cowsay-repl__input")!;
    this.subscriptionForm = this.host.querySelector<HTMLFormElement>('[data-role="subscription-form"]')!;
    this.subscriptionInput = this.host.querySelector<HTMLInputElement>(".cowsay-subscription__input")!;
    this.outputSelect = this.host.querySelector<HTMLSelectElement>('select[name="output-mode"]')!;
    this.logList = this.host.querySelector<HTMLElement>('[data-role="log-list"]')!;

    this.commandForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const command = this.commandInput!.value.trim();
      if (!command) return;
      this.commandInput!.value = "";
      void this.runCommand(command);
    });

    this.subscriptionForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const nextPattern = this.subscriptionInput!.value.trim() || "*";
      this.updateSubscription(nextPattern);
      this.pushLog("system", "subscription.updated", { subscription: this.subscription });
    });

    this.outputSelect.addEventListener("change", () => {
      this.outputMode = this.outputSelect!.value === "compact" ? "compact" : "pretty";
      this.renderLogs();
    });

    this.host.querySelectorAll<HTMLButtonElement>(".cowsay-examples button").forEach((button) => {
      button.addEventListener("click", () => {
        this.commandInput!.value = button.dataset.example ?? "";
        this.commandInput!.focus();
      });
    });

    this.updateSubscription(this.subscription);
    this.pushLog("system", "ready", {
      paneId: this.context.paneId,
      workspaceId: this.context.workspaceId
    });
  }

  private async runCommand(command: string) {
    this.pushLog("input", command);
    try {
      const result = await this.executeCommand(command);
      if (result !== undefined) {
        this.pushLog("result", "result", result);
      }
    } catch (error) {
      this.pushLog("error", error instanceof Error ? error.message : String(error));
    }
  }

  private async executeCommand(command: string): Promise<unknown> {
    const tokens = parser.tokenize(command);
    if (tokens.length === 0) return undefined;

    const [verb, ...rest] = tokens;
    switch (verb) {
      case "get":
        return this.context.shell.get(parser.required(rest[0], "get <path> requires a path"));
      case "ls":
        return this.context.shell.list(parser.required(rest[0], "ls <path> requires a path"));
      case "ls-each-get":
        return this.runListEachGet(parser.required(rest[0], "ls-each-get <path> requires a path"));
      case "set": {
        const path = parser.required(rest[0], "set <path> <value> requires a path");
        return this.context.shell.set(path, parser.coerceScalar(rest.slice(1).join(" ")));
      }
      case "call": {
        const path = parser.required(rest[0], "call <path> requires a path");
        const { named, extras } = parser.parseNamedArgs(rest.slice(1));
        if (extras.length > 0) throw new Error("call only accepts key=value arguments");
        return this.context.shell.call(path, named);
      }
      case "pub": {
        const topic = parser.required(rest[0], "pub <topic> requires a topic");
        const { named, extras } = parser.parseNamedArgs(rest.slice(1));
        const payload =
          Object.keys(named).length > 0
            ? { ...named, ...(extras.length > 0 ? { args: extras } : {}) }
            : extras.length <= 1
              ? (extras[0] ?? null)
              : extras;
        return this.context.bus.publish(topic, payload);
      }
      case "sub": {
        const pattern = parser.required(rest[0], "sub <pattern> requires a topic pattern");
        this.updateSubscription(pattern);
        return { ok: true, subscription: this.subscription };
      }
      case "clear":
        this.logs = [];
        this.renderLogs();
        return { ok: true };
      case "help":
        return { commands: ["get", "ls", "ls-each-get", "set", "call", "pub", "sub", "clear"] };
      default:
        throw new Error(`Unknown command '${verb}'. Try 'help'.`);
    }
  }

  private async runListEachGet(path: string) {
    const listed = await this.context.shell.list(path);
    if (!listed.ok || !listed.found) return listed;
    return Object.fromEntries(
      await Promise.all(
        listed.entries.map(async (entry) => [entry.path, unwrapValue(await this.context.shell.get(entry.path))])
      )
    );
  }

  private updateSubscription(pattern: string) {
    this.subscription = pattern || "*";
    this.subscriptionInput!.value = this.subscription;
    this.unsubscribeBus?.();
    this.unsubscribeBus = this.context.bus.subscribe(this.subscription, (event) => {
      this.pushLog("event", event.topic, event);
    });
  }

  private pushLog(kind: LogKind, message: string, value?: unknown) {
    this.logs.push({ kind, message, value, timestamp: Date.now() });
    if (this.logs.length > 200) this.logs.shift();
    this.renderLogs();
  }

  private renderLogs() {
    if (!this.logList) return;
    this.logList.replaceChildren(
      ...this.logs.map((entry) => {
        const card = document.createElement("article");
        card.className = `cowsay-log__entry cowsay-log__entry--${entry.kind}`;
        const meta = document.createElement("div");
        meta.className = "cowsay-log__meta";
        meta.textContent = `${formatTime(entry.timestamp)}  ${entry.kind}`;
        const body = document.createElement("pre");
        body.className = "cowsay-log__body";
        body.textContent =
          entry.value === undefined ? entry.message : `${entry.message}\n${formatValue(entry.value, this.outputMode)}`;
        card.append(meta, body);
        return card;
      })
    );
    this.logList.scrollTop = this.logList.scrollHeight;
  }
}

export default defineExtension({
  panes: [
    definePaneRenderer({
      kind: "cowsay",
      mount: (host, context) => new CowsayPaneRenderer(host, context)
    })
  ]
});
