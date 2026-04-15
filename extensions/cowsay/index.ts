import type { ExtensionPaneContext, ExtensionPaneInstance, ShellPathGetResult } from "@flmux/extension-api";
import { defineExtension, definePane } from "@flmux/extension-api";

type OutputMode = "pretty" | "compact";
type LogKind = "input" | "result" | "error" | "event" | "system";

interface LogEntry {
  kind: LogKind;
  message: string;
  value?: unknown;
  timestamp: number;
}

class CowsayPaneRenderer implements ExtensionPaneInstance {
  private outputMode: OutputMode = "pretty";
  private subscription = "*";
  private unsubscribeBus?: () => void;
  private logs: LogEntry[] = [];

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
    this.host.className = "cowsay-panel";
    this.mount();
  }

  dispose() {
    this.unsubscribeBus?.();
  }

  private mount() {
    this.host.innerHTML = `
      <div class="cowsay-panel__intro">
        <div>
          <strong>cowsay probe</strong>
          <p>Thin REPL/testbed for path model and renderer-local workspace messaging.</p>
        </div>
        <pre class="cowsay-panel__cow" aria-hidden="true"> ^__^
(oo)\\_______
(__)\\       )\\/\\
    ||----w |
    ||     ||</pre>
      </div>
      <div class="cowsay-panel__grid">
        <section class="cowsay-card">
          <header class="cowsay-card__header">
            <strong>REPL</strong>
            <span>get / ls / set / call / pub / sub</span>
          </header>
          <form class="cowsay-repl" data-role="command-form">
            <input class="cowsay-repl__input" name="command" type="text" spellcheck="false" placeholder="get /title" />
            <button type="submit">Run</button>
          </form>
          <div class="cowsay-examples">
            <button type="button" data-example="get /title">get /title</button>
            <button type="button" data-example="set /title moo">set /title moo</button>
            <button type="button" data-example="call /panes/new kind=browser place=right">new browser</button>
            <button type="button" data-example="call /panes/new kind=terminal cwd=. place=right">new terminal</button>
            <button type="button" data-example="pub cowsay.message text=moo">pub cowsay.message</button>
            <button type="button" data-example="ls-each-get /status/panes">ls-each-get /status/panes</button>
          </div>
        </section>
        <section class="cowsay-card">
          <header class="cowsay-card__header">
            <strong>Subscription</strong>
            <span>WorkspaceBus topic match: <code>*</code>, <code>prefix.*</code>, exact</span>
          </header>
          <form class="cowsay-subscription" data-role="subscription-form">
            <input class="cowsay-subscription__input" name="subscription" type="text" spellcheck="false" value="*" />
            <button type="submit">Apply</button>
          </form>
          <label class="cowsay-output">
            <span>Output</span>
            <select name="output-mode">
              <option value="pretty">Pretty JSON</option>
              <option value="compact">Compact JSON</option>
            </select>
          </label>
        </section>
      </div>
      <section class="cowsay-card cowsay-card--logs">
        <header class="cowsay-card__header">
          <strong>Log</strong>
          <span>Received messages and command results</span>
        </header>
        <div class="cowsay-log" data-role="log-list"></div>
      </section>
    `;

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
    const tokens = tokenize(command);
    if (tokens.length === 0) return undefined;

    const [verb, ...rest] = tokens;
    switch (verb) {
      case "get":
        return this.context.shell.get(requiredToken(rest[0], "get <path> requires a path"));
      case "ls":
        return this.context.shell.list(requiredToken(rest[0], "ls <path> requires a path"));
      case "ls-each-get":
        return this.runListEachGet(requiredToken(rest[0], "ls-each-get <path> requires a path"));
      case "set": {
        const path = requiredToken(rest[0], "set <path> <value> requires a path");
        return this.context.shell.set(path, coerceScalar(rest.slice(1).join(" ")));
      }
      case "call": {
        const path = requiredToken(rest[0], "call <path> requires a path");
        const { named, extras } = parseNamedArgs(rest.slice(1));
        if (extras.length > 0) throw new Error("call only accepts key=value arguments");
        return this.context.shell.call(path, named);
      }
      case "pub": {
        const topic = requiredToken(rest[0], "pub <topic> requires a topic");
        const { named, extras } = parseNamedArgs(rest.slice(1));
        const payload =
          Object.keys(named).length > 0
            ? { ...named, ...(extras.length > 0 ? { args: extras } : {}) }
            : extras.length <= 1
              ? (extras[0] ?? null)
              : extras;
        return this.context.bus.publish(topic, payload);
      }
      case "sub": {
        const pattern = requiredToken(rest[0], "sub <pattern> requires a topic pattern");
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

const cowsayPane = definePane({
  kind: "cowsay",
  mount: (host, context) => new CowsayPaneRenderer(host, context),
  getTitle: ({ input }) => input.title?.trim() || "Cowsay"
});

export default defineExtension({
  panes: [cowsayPane]
});

function requiredToken(token: string | undefined, message: string): string {
  if (!token) throw new Error(message);
  return token;
}

function unwrapValue(result: ShellPathGetResult) {
  if (!result.ok) return result;
  return result.found ? result.value : { found: false };
}

function parseNamedArgs(tokens: string[]) {
  const named: Record<string, unknown> = {};
  const extras: string[] = [];
  for (const token of tokens) {
    const equalsIndex = token.indexOf("=");
    if (equalsIndex <= 0) {
      extras.push(token);
      continue;
    }
    named[token.slice(0, equalsIndex)] = coerceScalar(token.slice(equalsIndex + 1));
  }
  return { named, extras };
}

function coerceScalar(rawValue: string): unknown {
  if (rawValue === "true") return true;
  if (rawValue === "false") return false;
  if (rawValue === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(rawValue)) return Number(rawValue);
  if ((rawValue.startsWith("{") && rawValue.endsWith("}")) || (rawValue.startsWith("[") && rawValue.endsWith("]"))) {
    try { return JSON.parse(rawValue); } catch { return rawValue; }
  }
  return rawValue;
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
  if (quote) throw new Error("Unterminated quoted string");
  if (current) tokens.push(current);
  return tokens;
}

function formatValue(value: unknown, mode: OutputMode): string {
  if (typeof value === "string") return value;
  return mode === "compact" ? JSON.stringify(value) : JSON.stringify(value, null, 2);
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}
