import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { EditorState, TransactionSpec } from "@codemirror/state";
import type { ShellModelAPI } from "@flmux/core/shell/types";
import {
  TextEditorPaneRenderer,
  type TextEditorPaneView,
  type TextEditorPaneViewFactory
} from "../src/renderer/panes/textEditorPane";

const MAX_TEXT_EDITOR_READ_BYTES = 5 * 1024 * 1024;

describe("TextEditorPaneRenderer", () => {
  beforeEach(() => {
    installMiniDom();
  });

  afterEach(() => {
    uninstallMiniDom();
  });

  it("reads a file and renders the content into the text editor state", async () => {
    const content = "alpha\nbeta\n";
    const calls: Array<{ path: string; args: Record<string, unknown> | undefined; sourcePaneId?: string }> = [];
    const views: FakeTextEditorView[] = [];
    const renderer = createRenderer({
      views,
      pathCall: async (path, args, caller) => {
        calls.push({ path, args, sourcePaneId: caller?.sourcePaneId });
        return { ok: true, value: { content, truncated: false } };
      }
    });

    init(renderer, { path: "/w/src/main.ts" });
    await flushDom();

    expect(calls).toEqual([
      {
        path: "/fs/read",
        args: { path: "/w/src/main.ts", maxBytes: MAX_TEXT_EDITOR_READ_BYTES },
        sourcePaneId: "pane.textEditor"
      }
    ]);
    expect(views[0]?.state.doc.toString()).toBe(content);
    expect(renderer.element.querySelector<HTMLElement>(".flmux-text-editor__banner")?.textContent).toBe("");
  });

  it("passes a max byte cap to the file read call", async () => {
    const calls: Array<{ path: string; args: Record<string, unknown> | undefined }> = [];
    const renderer = createRenderer({
      pathCall: async (path, args) => {
        calls.push({ path, args });
        return { ok: true, value: { content: "bounded", truncated: false } };
      }
    });

    init(renderer, { path: "/w/bounded.txt" });
    await flushDom();

    expect(calls).toEqual([
      {
        path: "/fs/read",
        args: { path: "/w/bounded.txt", maxBytes: MAX_TEXT_EDITOR_READ_BYTES }
      }
    ]);
  });

  it("clears the loading placeholder after an empty file loads", async () => {
    const views: FakeTextEditorView[] = [];
    const renderer = createRenderer({
      views,
      pathCall: async () => ({ ok: true, value: { content: "", truncated: false } })
    });

    init(renderer, { path: "/w/empty.txt" });
    await flushDom();

    expect(views[0]?.state.doc.toString()).toBe("");
    expect(renderer.element.querySelector('[data-role="text-editor-loading"]')).toBeNull();
    expect(renderer.element.textContent).not.toContain("Loading");
  });

  it("shows a truncated banner", async () => {
    const views: FakeTextEditorView[] = [];
    const renderer = createRenderer({
      views,
      pathCall: async () => ({ ok: true, value: { content: "abc", truncated: true } })
    });

    init(renderer, { path: "/w/large.txt" });
    await flushDom();

    const banner = renderer.element.querySelector<HTMLElement>(".flmux-text-editor__banner");
    expect(views[0]?.state.doc.toString()).toBe("abc");
    expect(banner?.hidden).toBe(false);
    expect(banner?.textContent).toContain("Truncated");
    expect(banner?.textContent).toContain("3 bytes");
  });

  it("renders an error placeholder when the read call rejects", async () => {
    const renderer = createRenderer({
      pathCall: async () => {
        throw new Error("simulated listDir failure");
      }
    });

    init(renderer, { path: "/w/missing.txt" });
    await flushDom();

    const error = renderer.element.querySelector('[data-role="text-editor-error"]');
    expect(error?.textContent).toContain("Could not open file");
    expect(error?.textContent).toContain("simulated listDir failure");
  });

  it("renders an error placeholder when the read call returns ok:false", async () => {
    const renderer = createRenderer({
      pathCall: async () => ({ ok: false, code: "NOT_FOUND", error: "Path not found" })
    });

    init(renderer, { path: "/w/missing.txt" });
    await flushDom();

    const error = renderer.element.querySelector('[data-role="text-editor-error"]');
    expect(error?.textContent).toContain("NOT_FOUND");
    expect(error?.textContent).toContain("Path not found");
  });

  it("dispose is idempotent and destroys the text editor view once", async () => {
    const views: FakeTextEditorView[] = [];
    const renderer = createRenderer({
      views,
      pathCall: async () => ({ ok: true, value: { content: "readonly", truncated: false } })
    });

    init(renderer, { path: "/w/readme.md" });
    await flushDom();

    const view = views[0];
    expect(view).toBeDefined();
    expect(() => {
      renderer.dispose();
      renderer.dispose();
    }).not.toThrow();
    expect(view?.destroyCalls).toBe(1);
  });
});

function createRenderer(options: {
  pathCall: ShellModelAPI["pathCall"];
  views?: FakeTextEditorView[];
}): TextEditorPaneRenderer {
  const textEditorViewFactory: TextEditorPaneViewFactory = ({ state, parent }) => {
    const view = new FakeTextEditorView(state, parent);
    options.views?.push(view);
    return view;
  };
  return new TextEditorPaneRenderer({
    shellModel: createShellModel(options.pathCall),
    textEditorViewFactory
  });
}

function init(renderer: TextEditorPaneRenderer, params: Record<string, unknown>): void {
  renderer.init({
    api: { id: "pane.textEditor" },
    params
  } as never);
}

function createShellModel(pathCall: ShellModelAPI["pathCall"]): ShellModelAPI {
  return {
    pathCall,
    pathGet: async () => ({ ok: true, found: false, value: null }),
    pathList: async () => ({ ok: true, found: false, entries: [] }),
    pathSet: async () => ({ ok: false, code: "NOT_WRITABLE", error: "not writable" })
  };
}

class FakeTextEditorView implements TextEditorPaneView {
  state: EditorState;
  readonly dom = document.createElement("div");
  destroyCalls = 0;
  focusCalls = 0;

  constructor(state: EditorState, parent: HTMLElement) {
    this.state = state;
    parent.append(this.dom);
  }

  dispatch(spec: TransactionSpec): void {
    this.state = this.state.update(spec).state;
  }

  focus(): void {
    this.focusCalls += 1;
  }

  destroy(): void {
    this.destroyCalls += 1;
    this.dom.remove();
  }
}

async function flushDom(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
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
  globals.Event = MiniEvent;
}

function uninstallMiniDom(): void {
  const globals = globalThis as unknown as Record<string, unknown>;
  delete globals["document"];
  delete globals["HTMLElement"];
  delete globals["Event"];
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
