import { defineView } from "flmux-sdk";
import { readDirEntries, type CoreFsEntry } from "./file-access";

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

    return {
      async mount(nextHost) {
        host = nextHost;

        const shell = document.createElement("div");
        shell.className = "explorer-pane";

        const toolbar = document.createElement("div");
        toolbar.className = "explorer-toolbar";

        pathLabel = document.createElement("span");
        pathLabel.className = "explorer-path";
        toolbar.append(pathLabel);

        list = document.createElement("div");
        list.className = "explorer-list";

        shell.append(toolbar, list);
        host.replaceChildren(shell);

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
      }
    };

    async function loadDir(dirPath: string): Promise<void> {
      if (!pathLabel || !list) {
        return;
      }
      currentPath = dirPath;
      pathLabel.textContent = dirPath;
      context.setState({ currentPath: dirPath });
      list.replaceChildren();

      try {
        const entries = await readDirEntries(dirPath);
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

    function buildEntry(entry: CoreFsEntry): HTMLElement {
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
          void loadDir(entry.path);
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

function normalizeParams(value: unknown): ExplorerParams {
  const raw = value as Partial<ExplorerParams> | null | undefined;
  return {
    rootPath: typeof raw?.rootPath === "string" ? raw.rootPath : ".",
    mode: raw?.mode === "dirtree" || raw?.mode === "filelist" ? raw.mode : "filetree"
  };
}
