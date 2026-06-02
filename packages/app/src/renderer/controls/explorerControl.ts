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
  /** Auto-descend the display root through a chain of single-child folders. */
  collapseSingleFolderRoot?: boolean;
  /** Mutation callbacks (single impl in the pane). Throw on failure → banner. */
  onCreateFile?(parentVirtual: string, name: string): Promise<void>;
  onCreateFolder?(parentVirtual: string, name: string): Promise<void>;
  onRename?(virtual: string, newName: string): Promise<void>;
  onDelete?(virtual: string, isDir: boolean): Promise<void>;
  initialExpanded?: readonly string[];
  className?: string;
  /** Header label (signed-in user / project name). */
  userLabel?: string;
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

interface EditRow {
  type: "edit";
  depth: number;
  glyph: string;
  initial: string;
}

type RenderRow = EntryRow | PlaceholderRow | EditRow;

type EditState =
  | { mode: "rename"; targetPath: string; parentPath: string; initial: string; isDir: boolean }
  | { mode: "createFile" | "createFolder"; parentPath: string };

const STYLESHEET_ID = "flmux-explorer-control-styles";

const EXPLORER_CSS = `
.explorer-panel {
  height: 100%;
  min-height: 0;
}
.flmux-explorer-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--fl-editor-background, #08101c);
}
.flmux-explorer__header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px 3px 10px;
  border-bottom: 1px solid var(--fl-border, rgba(255, 255, 255, 0.08));
  color: var(--fl-description-foreground, #97a9c8);
  font: 600 11px / 1.4 system-ui, sans-serif;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.flmux-explorer__header-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.flmux-explorer__header-btn {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--fl-description-foreground, #97a9c8);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
}
.flmux-explorer__header-btn:hover {
  color: var(--fl-foreground, #e6eefc);
  background: var(--fl-button-hover-background, rgba(255, 255, 255, 0.08));
}
.flmux-explorer__banner {
  flex: 0 0 auto;
  padding: 4px 10px;
  border-bottom: 1px solid var(--fl-border, rgba(255, 255, 255, 0.08));
  color: var(--fl-error-foreground, #ff9d9d);
  background: var(--fl-error-background, rgba(255, 64, 64, 0.12));
  font: 11px / 1.35 system-ui, sans-serif;
}
.flmux-explorer {
  flex: 1 1 auto;
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
.flmux-explorer__edit-input {
  flex: 1 1 auto;
  min-width: 0;
  border: 1px solid var(--fl-focus-border, #4ea1ff);
  border-radius: 3px;
  padding: 0 4px;
  color: var(--fl-foreground, #e6eefc);
  background: var(--fl-input-background, #0c1626);
  font: inherit;
  outline: none;
}
.flmux-explorer__placeholder {
  color: var(--fl-description-foreground, #97a9c8);
  font-style: italic;
}
.flmux-explorer__placeholder--error {
  color: var(--fl-error-foreground, #ff9d9d);
  font-style: normal;
}
.flmux-explorer__confirm-detail {
  margin: 10px 0 16px;
  color: var(--fl-description-foreground, #97a9c8);
  font: 12px / 1.45 system-ui, sans-serif;
}
.flmux-explorer__confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
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

  const panel = document.createElement("div");
  panel.className = ["flmux-explorer-panel", options.className ?? ""].filter(Boolean).join(" ");

  const { header } = buildHeader();
  const banner = document.createElement("div");
  banner.className = "flmux-explorer__banner";
  banner.hidden = true;

  const element = document.createElement("div");
  element.className = "flmux-explorer";
  element.tabIndex = 0;
  element.setAttribute("role", "tree");
  element.setAttribute("aria-label", "File explorer");

  panel.append(header, banner, element);

  const nodes = new Map<string, TreeNode>();
  const expanded = new Set<string>([rootPath]);
  const extensionSet = normalizeExtensions(options.extensions);
  let visibleEntryRows: EntryRow[] = [];
  let selectedPath: string | null = null;
  let loadToken = 0;
  let disposed = false;
  let displayRootPath = rootPath;
  let editing: EditState | null = null;
  let editSettled = false;
  let opInFlight = false;
  let closeMenu: (() => void) | null = null;

  // Single action set shared by header buttons + context menu. Target is an
  // explicit captured arg (not live selection) so a menu opened on one row
  // can't fire against another after a re-render. (References hoisted fns.)
  const actions = {
    refresh: () => refresh(),
    collapseAll: () => {
      for (const p of [...expanded]) if (p !== displayRootPath) expanded.delete(p);
      render();
    },
    newFile: (target: string | null) => beginCreate("createFile", target),
    newFolder: (target: string | null) => beginCreate("createFolder", target),
    rename: (path: string) => beginRename(path),
    delete: (path: string) => confirmAndDelete(path),
    copyPath: (path: string) => {
      navigator.clipboard?.writeText(path).catch(() => showBanner("Copy to clipboard failed"));
    }
  };

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
    if (disposed || editing || !(target instanceof HTMLElement)) return;
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
    if (disposed || editing || !(target instanceof HTMLElement)) return;
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

  const onContextMenu = (event: MouseEvent) => {
    if (disposed || editing) return;
    event.preventDefault();
    const target = event.target instanceof HTMLElement ? event.target : null;
    const row = target?.closest<HTMLElement>(".flmux-explorer__row[data-path]");
    const path = row?.dataset.path ?? null;
    if (path) setSelection(path);
    openContextMenu(event.clientX, event.clientY, path);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (disposed || editing) return;
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
      case "F2":
        event.preventDefault();
        if (selectedPath) actions.rename(selectedPath);
        break;
      case "Delete":
        event.preventDefault();
        if (selectedPath) void actions.delete(selectedPath);
        break;
    }
  };

  element.addEventListener("click", onClick);
  element.addEventListener("dblclick", onDoubleClick);
  element.addEventListener("contextmenu", onContextMenu);
  element.addEventListener("keydown", onKeyDown);
  container.append(panel);

  render();
  void loadDir(rootPath).then(() => expandInitialPaths());

  return {
    element: panel,
    refresh,
    focus() {
      element.focus();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      loadToken += 1;
      closeMenu?.();
      element.removeEventListener("click", onClick);
      element.removeEventListener("dblclick", onDoubleClick);
      element.removeEventListener("contextmenu", onContextMenu);
      element.removeEventListener("keydown", onKeyDown);
      panel.replaceChildren();
      panel.remove();
      nodes.clear();
      expanded.clear();
      visibleEntryRows = [];
      selectedPath = null;
    },
    getSelection() {
      return selectedPath ? selectionEvent(selectedPath) : null;
    }
  };


  function buildHeader(): { header: HTMLElement } {
    const head = document.createElement("div");
    head.className = "flmux-explorer__header";
    const label = document.createElement("span");
    label.className = "flmux-explorer__header-label";
    label.textContent = options.userLabel ?? "Files";
    label.title = label.textContent;
    head.append(label);
    const buttons: Array<{ glyph: string; title: string; run: () => void }> = [
      { glyph: "🗎", title: "New File", run: () => actions.newFile(selectedPath) },
      { glyph: "🖿", title: "New Folder", run: () => actions.newFolder(selectedPath) },
      { glyph: "↻", title: "Refresh", run: () => void actions.refresh() },
      { glyph: "⊟", title: "Collapse All", run: () => actions.collapseAll() }
    ];
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "flmux-explorer__header-btn";
      btn.textContent = b.glyph;
      btn.title = b.title;
      btn.setAttribute("aria-label", b.title);
      btn.addEventListener("click", b.run);
      head.append(btn);
    }
    return { header: head };
  }


  function createParent(target: string | null): string {
    if (!target) return displayRootPath;
    const node = nodes.get(target);
    if (node?.entry.kind === "dir") return target;
    return node?.parentPath ?? displayRootPath;
  }

  function beginCreate(mode: "createFile" | "createFolder", target: string | null): void {
    if (editing || opInFlight || disposed) return;
    const parentPath = createParent(target);
    editing = { mode, parentPath };
    editSettled = false;
    if (parentPath !== displayRootPath) expanded.add(parentPath);
    render();
    void loadDir(parentPath).then(() => {
      if (editing && editing.mode === mode) render();
    });
  }

  function beginRename(path: string): void {
    if (editing || opInFlight || disposed) return;
    if (path === displayRootPath || path === rootPath) return;
    const node = nodes.get(path);
    if (!node) return;
    editing = {
      mode: "rename",
      targetPath: path,
      parentPath: node.parentPath ?? displayRootPath,
      initial: node.entry.name,
      isDir: node.entry.kind === "dir"
    };
    editSettled = false;
    render();
  }

  async function commitEdit(value: string): Promise<void> {
    if (!editing || editSettled) return;
    editSettled = true;
    const state = editing;
    const name = value.trim();
    editing = null;
    if (!name || /[/\\]/.test(name) || name === "." || name === "..") {
      render();
      if (name) showBanner("Invalid name");
      return;
    }
    opInFlight = true;
    clearBanner();
    try {
      if (state.mode === "rename") {
        if (name === state.initial) {
          render();
          return;
        }
        await options.onRename?.(state.targetPath, name);
        pruneSubtree(state.targetPath);
        await refresh(state.parentPath);
      } else {
        const fn = state.mode === "createFile" ? options.onCreateFile : options.onCreateFolder;
        await fn?.(state.parentPath, name);
        await refresh(state.parentPath);
      }
    } catch (error) {
      showBanner(mutationMessage(error));
      render();
    } finally {
      opInFlight = false;
    }
  }

  function cancelEdit(): void {
    if (!editing || editSettled) return;
    editSettled = true;
    editing = null;
    render();
  }

  async function confirmAndDelete(path: string): Promise<void> {
    if (editing || opInFlight || disposed) return;
    if (path === displayRootPath || path === rootPath) return;
    const node = nodes.get(path);
    if (!node) return;
    const isDir = node.entry.kind === "dir";
    const ok = await openConfirm(
      `Delete "${node.entry.name}"?`,
      isDir ? "This folder and all its contents will be permanently deleted." : "This file will be permanently deleted."
    );
    if (!ok || disposed) return;
    opInFlight = true;
    clearBanner();
    try {
      await options.onDelete?.(path, isDir);
      const parent = node.parentPath ?? displayRootPath;
      pruneSubtree(path);
      if (selectedPath === path) selectedPath = null;
      await refresh(parent);
    } catch (error) {
      showBanner(mutationMessage(error));
    } finally {
      opInFlight = false;
    }
  }

  function pruneSubtree(path: string): void {
    for (const key of [...nodes.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) {
        nodes.delete(key);
        expanded.delete(key);
      }
    }
  }


  function openContextMenu(x: number, y: number, target: string | null): void {
    closeMenu?.();
    const node = target ? nodes.get(target) : null;
    const hasTarget = !!node;
    const items: Array<{ label: string; run: () => void; disabled?: boolean } | "sep"> = [
      { label: "New File", run: () => actions.newFile(target) },
      { label: "New Folder", run: () => actions.newFolder(target) },
      "sep",
      { label: "Rename", disabled: !hasTarget, run: () => target && actions.rename(target) },
      { label: "Delete", disabled: !hasTarget, run: () => target && void actions.delete(target) },
      "sep",
      { label: "Copy Path", disabled: !hasTarget, run: () => target && actions.copyPath(target) }
    ];

    const popup = document.createElement("div");
    popup.className = "header-action-popup";
    for (const item of items) {
      if (item === "sep") {
        const sep = document.createElement("div");
        sep.className = "header-action-popup__sep";
        popup.append(sep);
        continue;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "header-action-popup__item";
      btn.textContent = item.label;
      if (item.disabled) {
        btn.disabled = true;
        btn.style.opacity = "0.4";
      } else {
        btn.addEventListener("click", () => {
          closeMenu?.();
          item.run();
        });
      }
      popup.append(btn);
    }
    document.body.append(popup);
    popup.style.position = "fixed";
    popup.style.top = `${Math.min(y, window.innerHeight - popup.offsetHeight - 4)}px`;
    popup.style.left = `${Math.min(x, window.innerWidth - popup.offsetWidth - 4)}px`;

    const onDocPointerDown = (ev: PointerEvent) => {
      if (ev.target instanceof Node && popup.contains(ev.target)) return;
      closeMenu?.();
    };
    document.addEventListener("pointerdown", onDocPointerDown, true);
    closeMenu = () => {
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      popup.remove();
      closeMenu = null;
    };
  }

  function openConfirm(title: string, detail: string): Promise<boolean> {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "settings-overlay";
      const dialog = document.createElement("div");
      dialog.className = "settings-dialog";
      dialog.style.maxWidth = "360px";
      const h = document.createElement("div");
      h.className = "settings-dialog__title";
      h.textContent = title;
      const p = document.createElement("div");
      p.className = "flmux-explorer__confirm-detail";
      p.textContent = detail;
      const row = document.createElement("div");
      row.className = "flmux-explorer__confirm-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "settings-btn";
      cancel.textContent = "Cancel";
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.className = "settings-btn settings-btn--danger";
      confirm.textContent = "Delete";
      row.append(cancel, confirm);
      dialog.append(h, p, row);
      overlay.append(dialog);
      document.body.append(overlay);

      let settled = false;
      const close = (value: boolean) => {
        if (settled) return;
        settled = true;
        document.removeEventListener("keydown", onKey, true);
        overlay.remove();
        resolve(value);
      };
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") close(false);
      };
      overlay.addEventListener("pointerdown", (ev) => {
        if (ev.target === overlay) close(false);
      });
      cancel.addEventListener("click", () => close(false));
      confirm.addEventListener("click", () => close(true));
      document.addEventListener("keydown", onKey, true);
      confirm.focus();
    });
  }


  function showBanner(message: string): void {
    banner.textContent = message;
    banner.hidden = false;
  }
  function clearBanner(): void {
    banner.hidden = true;
    banner.textContent = "";
  }


  async function refresh(path?: string): Promise<void> {
    if (disposed) return;
    const targets = path ? [path] : visibleEntryRows.filter((row) => row.entry.kind === "dir").map((row) => row.path);
    const uniqueTargets = [...new Set([displayRootPath, ...targets])];
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
          if (path === displayRootPath) advanceDisplayRoot();
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

    // Inline edit lives in render state — re-focus the input after every rebuild.
    if (editing) {
      const input = element.querySelector<HTMLInputElement>(".flmux-explorer__edit-input");
      if (input && document.activeElement !== input) {
        input.focus();
        input.setSelectionRange(0, input.value.length);
      }
    }
  }

  function buildRows(): RenderRow[] {
    const rows: RenderRow[] = [];
    const pushChildren = (node: TreeNode, depth: number, out: RenderRow[]): void => {
      const childDepth = depth + 1;
      const creating = creatingIn(node);
      const children = (node.children ?? []).filter(shouldRenderEntry);
      if (children.length === 0 && !creating) {
        out.push({ type: "placeholder", message: "(empty)", tone: "muted", depth: childDepth });
        return;
      }
      for (const entry of children) {
        const childPath = joinPath(node.path, entry.name);
        visit(upsertChildNode(childPath, entry, node.path), childDepth);
      }
    };
    // The create input must show even while the parent dir is still loading,
    // so it's pushed before the loading/error early-returns.
    const pushCreateRow = (node: TreeNode, depth: number) => {
      if (creatingIn(node)) {
        rows.push({ type: "edit", depth, glyph: editing!.mode === "createFolder" ? "📁" : "📄", initial: "" });
      }
    };
    const visit = (node: TreeNode, depth: number) => {
      if (editing?.mode === "rename" && editing.targetPath === node.path) {
        rows.push({ type: "edit", depth, glyph: editing.isDir ? "📁" : "📄", initial: editing.initial });
      } else {
        rows.push({ type: "entry", path: node.path, entry: node.entry, parentPath: node.parentPath, depth });
      }

      if (node.entry.kind !== "dir" || !expanded.has(node.path)) return;
      pushCreateRow(node, depth + 1);
      if (node.loading) {
        rows.push({ type: "placeholder", message: "Loading", tone: "loading", depth: depth + 1 });
        return;
      }
      if (node.error) {
        rows.push({ type: "placeholder", message: node.error, tone: "error", depth: depth + 1 });
        return;
      }
      pushChildren(node, depth, rows);
    };

    const displayNode = nodes.get(displayRootPath) ?? rootNode;
    pushCreateRow(displayNode, 0);
    if (displayNode.loading) {
      rows.push({ type: "placeholder", message: "Loading", tone: "loading", depth: 0 });
    } else if (displayNode.error) {
      rows.push({ type: "placeholder", message: displayNode.error, tone: "error", depth: 0 });
    } else if (displayNode.children !== undefined) {
      pushChildren(displayNode, -1, rows);
    }
    return rows;
  }

  function creatingIn(node: TreeNode): boolean {
    return !!editing && editing.mode !== "rename" && editing.parentPath === node.path;
  }

  function advanceDisplayRoot(): void {
    if (!options.collapseSingleFolderRoot) return;
    while (true) {
      const node = nodes.get(displayRootPath);
      if (!node?.children) return;
      const visible = node.children.filter(shouldRenderEntry);
      if (visible.length !== 1 || visible[0]!.kind !== "dir") return;
      const childPath = joinPath(node.path, visible[0]!.name);
      const childNode = upsertChildNode(childPath, visible[0]!, node.path);
      displayRootPath = childPath;
      expanded.add(childPath);
      if (!childNode.children && !childNode.loading) {
        void loadDir(childPath);
        return;
      }
    }
  }

  function upsertChildNode(path: string, entry: ExplorerEntry, parentPath: string): TreeNode {
    const existing = nodes.get(path);
    if (existing) {
      existing.entry = entry;
      existing.parentPath = parentPath;
      return existing;
    }
    const node: TreeNode = { path, entry, parentPath, loading: false, loadToken: 0 };
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

    if (row.type === "edit") {
      const item = document.createElement("div");
      item.className = "flmux-explorer__row";
      const icon = document.createElement("span");
      icon.className = "flmux-explorer__icon";
      icon.textContent = row.glyph;
      const input = document.createElement("input");
      input.className = "flmux-explorer__edit-input";
      input.value = row.initial;
      input.spellcheck = false;
      input.addEventListener("keydown", (ev) => {
        // stopPropagation: commitEdit clears `editing` sync, so a bubbled Enter
        // would hit the tree handler and activate the selected row.
        if (ev.key === "Enter") {
          ev.preventDefault();
          ev.stopPropagation();
          void commitEdit(input.value);
        } else if (ev.key === "Escape") {
          ev.preventDefault();
          ev.stopPropagation();
          cancelEdit();
        }
      });
      input.addEventListener("blur", () => {
        // Defer: a re-render blurs then re-focuses the input. Only cancel if
        // focus genuinely left the control (no sync DOM work during replaceChildren).
        setTimeout(() => {
          if (editing && !editSettled && !element.contains(document.activeElement)) cancelEdit();
        }, 0);
      });
      item.append(createIndent(row.depth), spacerEl(), icon, input);
      return item;
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
    const chevron = isDir ? createChevron(row.path, isExpanded) : spacerEl();

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

  function spacerEl(): HTMLElement {
    const s = document.createElement("span");
    s.className = "flmux-explorer__chevron-spacer";
    return s;
  }

  function createIndent(depth: number): HTMLElement {
    const indent = document.createElement("span");
    indent.className = "flmux-explorer__indent";
    indent.style.width = `${Math.max(0, depth) * 14}px`;
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

function mutationMessage(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  switch (code) {
    case "ALREADY_EXISTS":
      return "A file or folder with that name already exists";
    case "NOT_WRITABLE":
      return "This location is read-only";
    case "NOT_EMPTY":
      return "Directory is not empty";
    case "INVALID_PATH":
      return "Invalid name or path";
    case "NOT_FOUND":
      return "Path not found";
    default:
      return errorMessage(error);
  }
}
