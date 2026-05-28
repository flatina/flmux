import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mountExplorerControl,
  type ExplorerActivateEvent,
  type ExplorerEntry
} from "../src/renderer/controls/explorerControl";

describe("ExplorerControl", () => {
  beforeEach(() => {
    installMiniDom();
  });

  afterEach(() => {
    uninstallMiniDom();
  });

  it("expands and collapses dirs lazily while filtering file extensions", async () => {
    const calls: string[] = [];
    const control = mountExplorerControl(document.createElement("div"), {
      root: "/",
      extensions: [".ts"],
      listDir: async (path) => {
        calls.push(path);
        return { entries: fixture[path] ?? [] };
      }
    });

    await flushDom();
    expect(calls).toEqual(["/"]);
    expect(pathExists(control.element, "/src")).toBe(true);
    expect(pathExists(control.element, "/README.md")).toBe(false);

    click(toggleFor(rowByPath(control.element, "/src")));
    await flushDom();
    expect(calls).toEqual(["/", "/src"]);
    expect(pathExists(control.element, "/src/index.ts")).toBe(true);
    expect(pathExists(control.element, "/src/index.js")).toBe(false);

    click(toggleFor(rowByPath(control.element, "/src")));
    expect(pathExists(control.element, "/src/index.ts")).toBe(false);

    click(toggleFor(rowByPath(control.element, "/src")));
    await flushDom();
    expect(calls.filter((path) => path === "/src")).toHaveLength(1);
  });

  it("hides files in dirOnly mode", async () => {
    const control = mountExplorerControl(document.createElement("div"), {
      root: "/",
      dirOnly: true,
      listDir: async (path) => ({ entries: fixture[path] ?? [] })
    });

    await flushDom();
    expect(pathExists(control.element, "/src")).toBe(true);
    expect(pathExists(control.element, "/README.md")).toBe(false);
    expect(pathExists(control.element, "/notes.txt")).toBe(false);
  });

  it("fires activate on file double-click", async () => {
    const activated: ExplorerActivateEvent[] = [];
    const control = mountExplorerControl(document.createElement("div"), {
      root: "/",
      extensions: [".ts"],
      listDir: async (path) => ({ entries: fixture[path] ?? [] }),
      onActivate: (event) => {
        activated.push(event);
      }
    });

    await flushDom();
    click(toggleFor(rowByPath(control.element, "/src")));
    await flushDom();
    dblclick(rowByPath(control.element, "/src/index.ts"));

    expect(activated).toEqual([
      {
        path: "/src/index.ts",
        entry: { name: "index.ts", kind: "file" }
      }
    ]);
  });

  it("survives a listDir rejection without crashing", async () => {
    const host = document.createElement("div");
    const control = mountExplorerControl(host, {
      root: "/",
      listDir: async () => {
        throw new Error("simulated listDir failure");
      }
    });

    await flushDom();
    // Control stayed mounted; no entry rows for the unloaded root.
    expect(host.children).toHaveLength(1);
    expect(pathExists(control.element, "/src")).toBe(false);
    // dispose is still safe after a rejected load.
    expect(() => control.dispose()).not.toThrow();
  });

  it("dispose is idempotent", async () => {
    const host = document.createElement("div");
    const control = mountExplorerControl(host, {
      root: "/",
      listDir: async (path) => ({ entries: fixture[path] ?? [] })
    });

    await flushDom();
    expect(host.children).toHaveLength(1);
    control.dispose();
    control.dispose();
    expect(host.children).toHaveLength(0);
  });
});

const fixture: Record<string, ExplorerEntry[]> = {
  "/": [
    { name: "src", kind: "dir" },
    { name: "README.md", kind: "file" },
    { name: "notes.txt", kind: "file" },
    { name: "socket", kind: "other" }
  ],
  "/src": [
    { name: "index.ts", kind: "file" },
    { name: "index.js", kind: "file" },
    { name: "nested", kind: "dir" }
  ],
  "/src/nested": []
};

async function flushDom(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function rowByPath(root: HTMLElement, path: string): HTMLElement {
  const row = Array.from(root.querySelectorAll<HTMLElement>(".flmux-explorer__row")).find(
    (candidate) => candidate.dataset.path === path
  );
  if (!row) throw new Error(`row not found: ${path}`);
  return row;
}

function pathExists(root: HTMLElement, path: string): boolean {
  return Array.from(root.querySelectorAll<HTMLElement>(".flmux-explorer__row")).some(
    (candidate) => candidate.dataset.path === path
  );
}

function toggleFor(row: HTMLElement): HTMLElement {
  const toggle = row.querySelector<HTMLElement>('[data-action="toggle"]');
  if (!toggle) throw new Error("toggle not found");
  return toggle;
}

function click(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function dblclick(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
}

type MiniListener = (event: MiniEvent) => void;

class MiniEvent {
  readonly type: string;
  readonly bubbles: boolean;
  defaultPrevented = false;
  target: MiniElement | null = null;
  currentTarget: MiniElement | null = null;
  private stopped = false;

  constructor(type: string, init: { bubbles?: boolean } = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? false;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.stopped = true;
  }

  get propagationStopped(): boolean {
    return this.stopped;
  }
}

class MiniMouseEvent extends MiniEvent {}

class MiniKeyboardEvent extends MiniEvent {
  readonly key: string;

  constructor(type: string, init: { bubbles?: boolean; key?: string } = {}) {
    super(type, init);
    this.key = init.key ?? "";
  }
}

class MiniClassList {
  constructor(private readonly element: MiniElement) {}

  add(...classes: string[]): void {
    this.element.className = [...new Set([...this.tokens(), ...classes])].join(" ");
  }

  remove(...classes: string[]): void {
    const remove = new Set(classes);
    this.element.className = this.tokens()
      .filter((token) => !remove.has(token))
      .join(" ");
  }

  contains(className: string): boolean {
    return this.tokens().includes(className);
  }

  toggle(className: string, force?: boolean): boolean {
    const hasClass = this.contains(className);
    const shouldHave = force ?? !hasClass;
    if (shouldHave) this.add(className);
    else this.remove(className);
    return shouldHave;
  }

  private tokens(): string[] {
    return this.element.className.split(/\s+/).filter(Boolean);
  }
}

class MiniElement {
  readonly tagName: string;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly classList = new MiniClassList(this);
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Set<MiniListener>>();
  parentElement: MiniElement | null = null;
  childNodes: MiniElement[] = [];
  className = "";
  id = "";
  tabIndex = 0;
  title = "";
  type = "";
  hidden = false;
  private text = "";

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get children(): MiniElement[] {
    return this.childNodes;
  }

  get textContent(): string {
    return this.text + this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value: string | null) {
    this.text = value ?? "";
    this.replaceChildren();
  }

  get isConnected(): boolean {
    let current: MiniElement | null = this;
    while (current) {
      if (current.tagName === "#DOCUMENT") return true;
      current = current.parentElement;
    }
    return false;
  }

  append(...nodes: MiniElement[]): void {
    for (const node of nodes) {
      node.remove();
      node.parentElement = this;
      this.childNodes.push(node);
    }
  }

  replaceChildren(...nodes: MiniElement[]): void {
    for (const child of this.childNodes) {
      child.parentElement = null;
    }
    this.childNodes = [];
    this.append(...nodes);
  }

  remove(): void {
    if (!this.parentElement) return;
    const siblings = this.parentElement.childNodes;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
    this.parentElement = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "id") this.id = value;
    if (name === "class") this.className = value;
    if (name.startsWith("data-")) this.dataset[toDatasetKey(name.slice(5))] = value;
  }

  getAttribute(name: string): string | null {
    if (name === "id") return this.id || null;
    if (name === "class") return this.className || null;
    if (name.startsWith("data-")) return this.dataset[toDatasetKey(name.slice(5))] ?? null;
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: MiniListener): void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(type: string, listener: MiniListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: MiniEvent): boolean {
    if (!event.target) event.target = this;
    let current: MiniElement | null = this;
    while (current) {
      event.currentTarget = current;
      for (const listener of current.listeners.get(event.type) ?? []) {
        listener.call(current, event);
      }
      if (!event.bubbles || event.propagationStopped) break;
      current = current.parentElement;
    }
    return !event.defaultPrevented;
  }

  contains(node: MiniElement): boolean {
    let current: MiniElement | null = node;
    while (current) {
      if (current === this) return true;
      current = current.parentElement;
    }
    return false;
  }

  closest(selector: string): MiniElement | null {
    let current: MiniElement | null = this;
    while (current) {
      if (matchesSelector(current, selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  querySelector<T extends MiniElement = MiniElement>(selector: string): T | null {
    return this.querySelectorAll<T>(selector)[0] ?? null;
  }

  querySelectorAll<T extends MiniElement = MiniElement>(selector: string): T[] {
    const found: T[] = [];
    const visit = (node: MiniElement) => {
      for (const child of node.childNodes) {
        if (matchesSelector(child, selector)) found.push(child as T);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  focus(): void {
    const document = miniDocument();
    if (document) document.activeElement = this;
  }
}

class MiniDocument extends MiniElement {
  readonly head = new MiniElement("head");
  readonly body = new MiniElement("body");
  activeElement: MiniElement | null = null;

  constructor() {
    super("#document");
    this.append(this.head, this.body);
  }

  createElement(tagName: string): MiniElement {
    return new MiniElement(tagName);
  }

  getElementById(id: string): MiniElement | null {
    const all: MiniElement[] = [];
    const visit = (node: MiniElement) => {
      for (const child of node.childNodes) {
        all.push(child);
        visit(child);
      }
    };
    visit(this);
    return all.find((element) => element.id === id) ?? null;
  }
}

function installMiniDom(): void {
  const document = new MiniDocument();
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.document = document as unknown as Document;
  globals.HTMLElement = MiniElement;
  globals.MouseEvent = MiniMouseEvent;
  globals.KeyboardEvent = MiniKeyboardEvent;
}

function uninstallMiniDom(): void {
  const globals = globalThis as unknown as Record<string, unknown>;
  delete globals["document"];
  delete globals["HTMLElement"];
  delete globals["MouseEvent"];
  delete globals["KeyboardEvent"];
}

function miniDocument(): MiniDocument | null {
  const value = (globalThis as typeof globalThis & { document?: unknown }).document;
  return value instanceof MiniDocument ? value : null;
}

function matchesSelector(element: MiniElement, selector: string): boolean {
  const classMatch = selector.match(/\.([A-Za-z0-9_-]+)/);
  if (classMatch && !element.classList.contains(classMatch[1]!)) return false;

  const dataMatch = selector.match(/\[data-([A-Za-z0-9-]+)(?:="([^"]*)")?\]/);
  if (dataMatch) {
    const key = toDatasetKey(dataMatch[1]!);
    const expected = dataMatch[2];
    if (!(key in element.dataset)) return false;
    if (expected !== undefined && element.dataset[key] !== expected) return false;
  }

  return Boolean(classMatch || dataMatch);
}

function toDatasetKey(value: string): string {
  return value.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
}
