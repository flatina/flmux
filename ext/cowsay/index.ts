import type { ExtensionMount, PaneEvent } from "../../src/shared/extension-abi";

interface CowsayState {
  text: string;
  receivedEvents: Array<{ type: string; data: unknown; source: string }>;
}

export const mount: ExtensionMount = (host, context) => {
  const state = (context.initialState ?? { text: "", receivedEvents: [] }) as CowsayState;
  const receivedEvents = [...state.receivedEvents];

  const wrapper = document.createElement("div");
  wrapper.style.cssText = "padding:12px;font-family:monospace;display:flex;flex-direction:column;height:100%;";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Type something...";
  input.value = state.text;
  input.style.cssText = "padding:6px;font-size:14px;margin-bottom:8px;background:#1e1e1e;color:#d4d4d4;border:1px solid #555;border-radius:3px;";

  const output = document.createElement("pre");
  output.style.cssText = "flex:1 0 auto;overflow:auto;color:#d4d4d4;font-size:13px;line-height:1.4;margin-bottom:8px;";

  const eventLog = document.createElement("pre");
  eventLog.style.cssText = "flex:0 0 auto;max-height:120px;overflow:auto;color:#888;font-size:11px;line-height:1.3;border-top:1px solid #444;padding-top:4px;";
  eventLog.setAttribute("data-testid", "event-log");

  function render(text: string): void {
    const safe = text || "...";
    const top = " " + "_".repeat(safe.length + 2);
    const mid = "< " + safe + " >";
    const bot = " " + "-".repeat(safe.length + 2);
    output.textContent = [
      top, mid, bot,
      "        \\   ^__^",
      "         \\  (oo)\\_______",
      "            (__)\\       )\\/\\",
      "                ||----w |",
      "                ||     ||"
    ].join("\n");
  }

  function updateEventLog(): void {
    eventLog.textContent = receivedEvents.length
      ? receivedEvents.map((e) => `[${e.type}] ${JSON.stringify(e.data)}`).join("\n")
      : "(no events received)";
  }

  function saveState(): void {
    context.setState({ text: input.value, receivedEvents } satisfies CowsayState);
  }

  render(input.value);
  updateEventLog();

  input.addEventListener("input", () => {
    render(input.value);
    context.emit("cowsay:said", { text: input.value });
    saveState();
  });

  const unsub = context.on("cowsay:said", (event: PaneEvent) => {
    if (event.source === context.paneId) return;
    receivedEvents.push({ type: event.type, data: event.data, source: String(event.source) });
    if (receivedEvents.length > 50) receivedEvents.shift();
    updateEventLog();
    saveState();
  });

  // Example: change app titlebar text via event bus
  context.emit("app:title", { title: "cowsay app" });

  wrapper.append(input, output, eventLog);
  host.append(wrapper);

  return {
    dispose() {
      unsub();
      wrapper.remove();
    }
  };
};
