export interface ExplorerEntry {
  name: string;
  kind: "dir" | "file" | "other";
  size?: number;
  mtimeMs?: number;
}

export interface ExplorerActivateEvent {
  path: string;
  entry: ExplorerEntry;
}

export interface ExplorerControlOptions {
  root: string;
  listDir(path: string): Promise<{ entries: ExplorerEntry[] }>;
  dirOnly?: boolean;
  extensions?: readonly string[];
  filter?: (entry: ExplorerEntry) => boolean;
  onActivate?(event: ExplorerActivateEvent): void;
  onSelect?(event: ExplorerActivateEvent | null): void;
  initialExpanded?: readonly string[];
  className?: string;
}

export interface ExplorerControlInstance {
  readonly element: HTMLElement;
  refresh(path?: string): Promise<void>;
  focus(): void;
  dispose(): void;
  getSelection(): ExplorerActivateEvent | null;
}

interface TreeNode {
  path: string;
  entry: ExplorerEntry;
  parentPath: string | null;
  children?: ExplorerEntry[];
  error?: string;
  loading: boolean;
  loadToken: number;
  inFlight?: Promise<void>;
}

interface EntryRow {
  type: "entry";
  path: string;
  entry: ExplorerEntry;
  parentPath: string | null;
  depth: number;
}

interface PlaceholderRow {
  type: "placeholder";
  message: string;
  tone: "muted" | "error" | "loading";
  depth: number;
}

type RenderRow = EntryRow | PlaceholderRow;

const STYLESHEET_ID = "flmux-explorer-control-styles";

const EXPLORER_CSS = `
.explorer-panel {
  height: 100%;
  min-height: 0;
}
.flmux-explorer {
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding: 4px 0;
  color: var(--fl-foreground, #e6eefc);
  background: var(--fl-editor-background, #08101c);
  font: 12px / 1.4 system-ui, sans-serif;
  outline: none;
}
.flmux-explorer__row {
  min-height: 22px;
  display: flex;
  align-items: center;
  padding: 0 8px 0 4px;
  gap: 3px;
  white-space: nowrap;
  user-select: none;
  cursor: default;
}
.flmux-explorer__row:hover {
  background: rgba(136, 214, 201, 0.09);
}
.flmux-explorer__row--selected {
  background: rgba(136, 214, 201, 0.18);
  color: var(--fl-foreground, #e6eefc);
}
.flmux-explorer__indent {
  flex: 0 0 auto;
  height: 1px;
}
.flmux-explorer__chevron {
  width: 18px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 3px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--fl-description-foreground, #97a9c8);
  background: transparent;
  line-height: 1;
}
.flmux-explorer__chevron:hover {
  color: var(--fl-foreground, #e6eefc);
  background: var(--fl-button-hover-background, rgba(255, 255, 255, 0.08));
}
.flmux-explorer__chevron-spacer {
  width: 18px;
  flex: 0 0 18px;
}
.flmux-explorer__icon {
  width: 18px;
  flex: 0 0 18px;
  text-align: center;
}
.flmux-explorer__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.flmux-explorer__placeholder {
  color: var(--fl-description-foreground, #97a9c8);
  font-style: italic;
}
.flmux-explorer__placeholder--error {
  color: var(--fl-error-foreground, #ff9d9d);
  font-style: normal;
}
.flmux-explorer__spinner {
  width: 11px;
  height: 11px;
  border: 1px solid var(--fl-description-foreground, #97a9c8);
  border-top-color: transparent;
  border-radius: 50%;
  animation: flmux-explorer-spin 800ms linear infinite;
}
@keyframes flmux-explorer-spin {
  to { transform: rotate(360deg); }
}
`;

export function mountExplorerControl(
  container: HTMLElement,
  options: ExplorerControlOptions
): ExplorerControlInstance {
  ensureStylesheet(STYLESHEET_ID, EXPLORER_CSS);

  const rootPath = options.root || "/";
  const element = document.createElement("div");
  element.className = ["flmux-explorer", options.className ?? ""].filter(Boolean).join(" ");
  element.tabIndex = 0;
  element.setAttribute("role", "tree");
  element.setAttribute("aria-label", "File explorer");

  const nodes = new Map<string, TreeNode>();
  const expanded = new Set<string>([rootPath]);
  const extensionSet = normalizeExtensions(options.extensions);
  let visibleEntryRows: EntryRow[] = [];
  let selectedPath: string | null = null;
  let loadToken = 0;
  let disposed = false;

  const rootNode: TreeNode = {
    path: rootPath,
    entry: { name: rootLabel(rootPath), kind: "dir" },
    parentPath: null,
    loading: false,
    loadToken: 0
  };
  nodes.set(rootPath, rootNode);

  const onClick = (event: MouseEvent) => {
    const target = event.target;
    if (disposed || !(target instanceof HTMLElement)) return;
    const row = target.closest<HTMLElement>(".flmux-explorer__row[data-path]");
    if (!row || !element.contains(row)) return;
    const path = row.dataset.path;
    if (!path) return;

    setSelection(path);
    if (target.closest('[data-action="toggle"]')) {
      event.preventDefault();
      void togglePath(path);
    }
  };

  const onDoubleClick = (event: MouseEvent) => {
    const target = event.target;
    if (disposed || !(target instanceof HTMLElement)) return;
    if (target.closest('[data-action="toggle"]')) return;
    const row = target.closest<HTMLElement>(".flmux-explorer__row[data-path]");
    if (!row || !element.contains(row)) return;
    const path = row.dataset.path;
    if (!path) return;
    setSelection(path);
    const node = nodes.get(path);
    if (node && node.entry.kind === "dir") {
      void togglePath(path);
    } else {
      activate(path);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (disposed) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveSelection(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveSelection(-1);
        break;
      case "ArrowRight":
        event.preventDefault();
        void moveRight();
        break;
      case "ArrowLeft":
        event.preventDefault();
        moveLeft();
        break;
      case "Enter":
        event.preventDefault();
        if (selectedPath) activate(selectedPath);
        break;
    }
  };

  element.addEventListener("click", onClick);
  element.addEventListener("dblclick", onDoubleClick);
  element.addEventListener("keydown", onKeyDown);
  container.append(element);

  render();
  void loadDir(rootPath).then(() => expandInitialPaths());

  return {
    element,
    refresh,
    focus() {
      element.focus();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      loadToken += 1;
      element.removeEventListener("click", onClick);
      element.removeEventListener("dblclick", onDoubleClick);
      element.removeEventListener("keydown", onKeyDown);
      element.replaceChildren();
      element.remove();
      nodes.clear();
      expanded.clear();
      visibleEntryRows = [];
      selectedPath = null;
    },
    getSelection() {
      return selectedPath ? selectionEvent(selectedPath) : null;
    }
  };

  async function refresh(path?: string): Promise<void> {
    if (disposed) return;
    const targets = path ? [path] : visibleEntryRows.filter((row) => row.entry.kind === "dir").map((row) => row.path);
    const uniqueTargets = [...new Set(targets)];
    const loads: Promise<void>[] = [];

    for (const targetPath of uniqueTargets) {
      const node = nodes.get(targetPath);
      if (!node) continue; // unknown path — bail rather than create a disconnected node.
      node.children = undefined;
      node.error = undefined;
      loads.push(loadDir(targetPath, { force: true }));
    }

    render();
    await Promise.all(loads);
  }

  async function expandInitialPaths(): Promise<void> {
    if (disposed) return;
    const paths = [...(options.initialExpanded ?? [])]
      .filter((path) => path !== rootPath)
      .sort((a, b) => pathDepth(a) - pathDepth(b));

    for (const path of paths) {
      for (const ancestor of ancestorPaths(rootPath, path)) {
        const node = nodes.get(ancestor);
        if (!node || node.entry.kind !== "dir") break;
        expanded.add(ancestor);
        render();
        await loadDir(ancestor);
      }
    }
  }

  async function togglePath(path: string): Promise<void> {
    const node = nodes.get(path);
    if (!node || node.entry.kind !== "dir") return;
    if (expanded.has(path)) {
      expanded.delete(path);
      render();
      return;
    }
    expanded.add(path);
    render();
    await loadDir(path);
  }

  async function loadDir(path: string, loadOptions: { force?: boolean } = {}): Promise<void> {
    const node = nodes.get(path);
    if (!node || node.entry.kind !== "dir" || disposed) return;
    if (node.children && !loadOptions.force) return;
    if (node.loading && !loadOptions.force) return node.inFlight ?? Promise.resolve();

    const token = ++loadToken;
    node.loadToken = token;
    node.loading = true;
    node.error = undefined;
    render();

    const promise = (async () => {
      try {
        const result = await options.listDir(path);
        if (disposed || node.loadToken !== token) return;
        node.children = result.entries;
        node.error = undefined;
      } catch (error) {
        if (disposed || node.loadToken !== token) return;
        node.children = undefined;
        node.error = errorMessage(error);
      } finally {
        if (!disposed && node.loadToken === token) {
          node.loading = false;
          node.inFlight = undefined;
          render();
        }
      }
    })();

    node.inFlight = promise;
    await promise;
  }

  function render(): void {
    if (disposed) return;
    const rows = buildRows();
    visibleEntryRows = rows.filter((row): row is EntryRow => row.type === "entry");

    if (selectedPath && !visibleEntryRows.some((row) => row.path === selectedPath)) {
      selectedPath = null;
      options.onSelect?.(null);
    }

    element.replaceChildren(...rows.map((row) => renderRow(row)));
  }

  function buildRows(): RenderRow[] {
    const rows: RenderRow[] = [];
    const visit = (node: TreeNode, depth: number) => {
      rows.push({
        type: "entry",
        path: node.path,
        entry: node.entry,
        parentPath: node.parentPath,
        depth
      });

      if (node.entry.kind !== "dir" || !expanded.has(node.path)) return;
      if (node.loading) {
        rows.push({ type: "placeholder", message: "Loading", tone: "loading", depth: depth + 1 });
        return;
      }
      if (node.error) {
        rows.push({ type: "placeholder", message: node.error, tone: "error", depth: depth + 1 });
        return;
      }
      if (!node.children) return;

      const children = node.children.filter(shouldRenderEntry);
      if (children.length === 0) {
        rows.push({ type: "placeholder", message: "(empty)", tone: "muted", depth: depth + 1 });
        return;
      }

      for (const entry of children) {
        const childPath = joinPath(node.path, entry.name);
        visit(upsertChildNode(childPath, entry, node.path), depth + 1);
      }
    };

    // Root row hidden; children render at depth 0.
    if (rootNode.loading) {
      rows.push({ type: "placeholder", message: "Loading", tone: "loading", depth: 0 });
    } else if (rootNode.error) {
      rows.push({ type: "placeholder", message: rootNode.error, tone: "error", depth: 0 });
    } else if (rootNode.children) {
      const children = rootNode.children.filter(shouldRenderEntry);
      if (children.length === 0) {
        rows.push({ type: "placeholder", message: "(empty)", tone: "muted", depth: 0 });
      } else {
        for (const entry of children) {
          const childPath = joinPath(rootNode.path, entry.name);
          visit(upsertChildNode(childPath, entry, rootNode.path), 0);
        }
      }
    }
    return rows;
  }

  function upsertChildNode(path: string, entry: ExplorerEntry, parentPath: string): TreeNode {
    const existing = nodes.get(path);
    if (existing) {
      existing.entry = entry;
      existing.parentPath = parentPath;
      return existing;
    }
    const node: TreeNode = {
      path,
      entry,
      parentPath,
      loading: false,
      loadToken: 0
    };
    nodes.set(path, node);
    return node;
  }

  function renderRow(row: RenderRow): HTMLElement {
    if (row.type === "placeholder") {
      const placeholder = document.createElement("div");
      placeholder.className = [
        "flmux-explorer__row",
        "flmux-explorer__placeholder",
        row.tone === "error" ? "flmux-explorer__placeholder--error" : ""
      ]
        .filter(Boolean)
        .join(" ");
      const indent = createIndent(row.depth);
      const spacer = document.createElement("span");
      spacer.className = "flmux-explorer__chevron-spacer";
      if (row.tone === "loading") {
        const spinner = document.createElement("span");
        spinner.className = "flmux-explorer__spinner";
        spacer.replaceChildren(spinner);
      }
      const label = document.createElement("span");
      label.className = "flmux-explorer__name";
      label.textContent = row.message;
      placeholder.append(indent, spacer, label);
      return placeholder;
    }

    const isDir = row.entry.kind === "dir";
    const isExpanded = expanded.has(row.path);
    const item = document.createElement("div");
    item.className = ["flmux-explorer__row", selectedPath === row.path ? "flmux-explorer__row--selected" : ""]
      .filter(Boolean)
      .join(" ");
    item.dataset.path = row.path;
    item.setAttribute("role", "treeitem");
    item.setAttribute("aria-level", String(row.depth + 1));
    item.setAttribute("aria-selected", selectedPath === row.path ? "true" : "false");
    if (isDir) item.setAttribute("aria-expanded", isExpanded ? "true" : "false");

    const indent = createIndent(row.depth);
    const chevron = isDir ? createChevron(row.path, isExpanded) : document.createElement("span");
    if (!isDir) chevron.className = "flmux-explorer__chevron-spacer";

    const icon = document.createElement("span");
    icon.className = "flmux-explorer__icon";
    icon.textContent = row.entry.kind === "dir" ? "📁" : row.entry.kind === "file" ? "📄" : "?";

    const name = document.createElement("span");
    name.className = "flmux-explorer__name";
    name.textContent = row.entry.name;
    name.title = row.path;

    item.append(indent, chevron, icon, name);
    return item;
  }

  function createIndent(depth: number): HTMLElement {
    const indent = document.createElement("span");
    indent.className = "flmux-explorer__indent";
    indent.style.width = `${depth * 14}px`;
    return indent;
  }

  function createChevron(path: string, isExpanded: boolean): HTMLButtonElement {
    const chevron = document.createElement("button");
    chevron.type = "button";
    chevron.className = "flmux-explorer__chevron";
    chevron.tabIndex = -1;
    chevron.dataset.action = "toggle";
    chevron.dataset.path = path;
    chevron.setAttribute("aria-label", isExpanded ? "Collapse folder" : "Expand folder");
    chevron.textContent = isExpanded ? "▾" : "▸";
    return chevron;
  }

  function setSelection(path: string | null): void {
    if (selectedPath === path) return;
    if (path && !nodes.has(path)) return;
    selectedPath = path;
    options.onSelect?.(path ? selectionEvent(path) : null);
    render();
  }

  function selectionEvent(path: string): ExplorerActivateEvent | null {
    const node = nodes.get(path);
    return node ? { path, entry: node.entry } : null;
  }

  function activate(path: string): void {
    const event = selectionEvent(path);
    if (event) options.onActivate?.(event);
  }

  function moveSelection(delta: 1 | -1): void {
    if (visibleEntryRows.length === 0) return;
    if (!selectedPath) {
      setSelection(visibleEntryRows[delta === 1 ? 0 : visibleEntryRows.length - 1]!.path);
      return;
    }
    const index = visibleEntryRows.findIndex((row) => row.path === selectedPath);
    const next = Math.min(Math.max((index === -1 ? 0 : index) + delta, 0), visibleEntryRows.length - 1);
    setSelection(visibleEntryRows[next]!.path);
  }

  async function moveRight(): Promise<void> {
    if (!selectedPath) {
      moveSelection(1);
      return;
    }
    const row = visibleEntryRows.find((candidate) => candidate.path === selectedPath);
    if (!row || row.entry.kind !== "dir") return;
    if (!expanded.has(row.path)) {
      expanded.add(row.path);
      render();
      await loadDir(row.path);
      return;
    }

    const index = visibleEntryRows.findIndex((candidate) => candidate.path === row.path);
    const child = visibleEntryRows[index + 1];
    if (child && child.depth > row.depth) setSelection(child.path);
  }

  function moveLeft(): void {
    if (!selectedPath) return;
    const row = visibleEntryRows.find((candidate) => candidate.path === selectedPath);
    if (!row) return;
    if (row.entry.kind === "dir" && expanded.has(row.path)) {
      expanded.delete(row.path);
      render();
      return;
    }
    if (row.parentPath) setSelection(row.parentPath);
  }

  function shouldRenderEntry(entry: ExplorerEntry): boolean {
    if (options.dirOnly && entry.kind !== "dir") return false;
    if (entry.kind !== "dir" && extensionSet && !extensionSet.has(extensionOf(entry.name))) return false;
    return options.filter ? options.filter(entry) : true;
  }
}

function ensureStylesheet(id: string, css: string): void {
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = css;
  document.head.append(style);
}

function normalizeExtensions(extensions: readonly string[] | undefined): ReadonlySet<string> | null {
  if (!extensions || extensions.length === 0) return null;
  return new Set(extensions.map((extension) => extension.toLowerCase()));
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index).toLowerCase() : "";
}

function joinPath(parent: string, name: string): string {
  if (parent === "/") return `/${name}`;
  const trimmed = parent.replace(/[\\/]+$/, "");
  return trimmed ? `${trimmed}/${name}` : name;
}

function rootLabel(path: string): string {
  if (path === "/") return "/";
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).pop() ?? path;
}

function pathDepth(path: string): number {
  return path.split(/[\\/]/).filter(Boolean).length;
}

function ancestorPaths(rootPath: string, targetPath: string): string[] {
  if (targetPath === rootPath) return [rootPath];
  const root = rootPath === "/" ? "/" : rootPath.replace(/[\\/]+$/, "");
  const target = targetPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (root !== "/" && target !== root && !target.startsWith(`${root.replace(/\\/g, "/")}/`)) return [];

  const relative = root === "/" ? target.replace(/^\/+/, "") : target.slice(root.length + 1);
  const segments = relative.split("/").filter(Boolean);
  const paths: string[] = [];
  let current = root === "/" ? "" : root;
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : `/${segment}`;
    paths.push(current);
  }
  return paths;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
