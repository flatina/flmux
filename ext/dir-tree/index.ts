import { defineView } from "flmux-sdk";

type ExplorerParams = {
  rootPath: string;
  mode: "filetree" | "dirtree" | "filelist";
};

type ExplorerState = {
  currentPath?: string;
};

export default defineView<ExplorerParams, ExplorerState>({
  createInstance(context) {
    let params = normalizeParams(context.params);
    let currentPath = context.state?.currentPath ?? params.rootPath;
    let host: HTMLElement | null = null;
    let pathLabel: HTMLSpanElement | null = null;
    let list: HTMLDivElement | null = null;
    const backStack: string[] = [];
    const forwardStack: string[] = [];
    let backBtn: HTMLButtonElement | null = null;
    let forwardBtn: HTMLButtonElement | null = null;

    function goBack() {
      if (backStack.length > 0) {
        forwardStack.push(currentPath);
        void loadDir(backStack.pop()!);
      }
    }

    function goForward() {
      if (forwardStack.length > 0) {
        backStack.push(currentPath);
        void loadDir(forwardStack.pop()!);
      }
    }

    function syncNavButtons() {
      if (backBtn) backBtn.disabled = backStack.length === 0;
      if (forwardBtn) forwardBtn.disabled = forwardStack.length === 0;
    }

    return {
      async mount(nextHost) {
        host = nextHost;

        const shell = document.createElement("div");
        shell.className = "explorer-pane";

        const toolbar = document.createElement("div");
        toolbar.className = "explorer-toolbar";

        backBtn = createNavBtn("\u2190", "Back", goBack);
        forwardBtn = createNavBtn("\u2192", "Forward", goForward);

        const upBtn = createNavBtn("\u2191", "Parent", () => {
          const parent = parentDir(currentPath);
          if (parent && parent !== currentPath) void navigate(parent);
        });

        const refreshBtn = createNavBtn("\u21BB", "Refresh", () => {
          void loadDir(currentPath);
        });

        pathLabel = document.createElement("span");
        pathLabel.className = "explorer-path";

        toolbar.append(backBtn, forwardBtn, upBtn, refreshBtn, pathLabel);

        list = document.createElement("div");
        list.className = "explorer-list";

        shell.append(toolbar, list);
        host.replaceChildren(shell);

        shell.addEventListener("mouseup", (event) => {
          if (event.button === 3) { event.preventDefault(); goBack(); }
          if (event.button === 4) { event.preventDefault(); goForward(); }
        });

        await loadDir(currentPath);
      },
      async update(nextParams) {
        params = normalizeParams(nextParams);
        currentPath = params.rootPath;
        await loadDir(currentPath);
      },
      dispose() {
        host?.replaceChildren();
        host = null;
        pathLabel = null;
        list = null;
        backBtn = null;
        forwardBtn = null;
      }
    };

    async function navigate(dirPath: string): Promise<void> {
      if (dirPath !== currentPath) {
        backStack.push(currentPath);
        forwardStack.length = 0;
      }
      await loadDir(dirPath);
    }

    async function loadDir(dirPath: string): Promise<void> {
      if (!pathLabel || !list) {
        return;
      }
      currentPath = dirPath;
      pathLabel.textContent = dirPath;
      syncNavButtons();
      context.setState({ currentPath: dirPath });
      list.replaceChildren();

      try {
        const entries = await context.fs.readDir(dirPath);
        for (const entry of entries) {
          list.append(buildEntry(entry));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const errorRow = document.createElement("div");
        errorRow.className = "explorer-entry explorer-error";
        errorRow.textContent = `[error] ${message}`;
        list.append(errorRow);
      }
    }

    function buildEntry(entry: { name: string; path: string; isDir: boolean }): HTMLElement {
      const row = document.createElement("div");
      row.className = `explorer-entry ${entry.isDir ? "explorer-dir" : "explorer-file"}`;

      const icon = document.createElement("span");
      icon.className = "explorer-icon";
      icon.textContent = entry.isDir ? "\u{1F4C1}" : "\u{1F4C4}";

      const name = document.createElement("span");
      name.className = "explorer-name";
      name.textContent = entry.name;

      row.append(icon, name);

      if (entry.isDir) {
        row.addEventListener("click", () => {
          void navigate(entry.path);
        });
      } else {
        row.addEventListener("dblclick", () => {
          void context.openPane(
            { kind: "editor", filePath: entry.path },
            { direction: "right" }
          );
        });
      }

      return row;
    }
  }
});

function createNavBtn(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "explorer-nav-btn";
  btn.textContent = text;
  btn.title = title;
  btn.addEventListener("click", onClick);
  return btn;
}

function parentDir(path: string): string | null {
  const normalized = path.replace(/[\\/]+$/, "");
  const idx = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (idx <= 0) return null;
  return normalized.slice(0, idx);
}

function normalizeParams(value: unknown): ExplorerParams {
  const raw = value as Partial<ExplorerParams> | null | undefined;
  return {
    rootPath: typeof raw?.rootPath === "string" ? raw.rootPath : ".",
    mode: raw?.mode === "dirtree" || raw?.mode === "filelist" ? raw.mode : "filetree"
  };
}
