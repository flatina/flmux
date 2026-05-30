import type { GroupPanelPartInitParameters, IContentRenderer, PanelUpdateEvent } from "dockview-core";
import type { ShellModelAPI } from "@flmux/core/shell/types";
import {
  mountExplorerControl,
  type ExplorerControlInstance,
  type ExplorerEntry
} from "../controls/explorerControl";

interface ExplorerPaneRendererDependencies {
  shellModel: ShellModelAPI;
  userLabel?: string;
}

type ExplorerPaneParams = {
  root?: string;
};

export class ExplorerPaneRenderer implements IContentRenderer {
  readonly element = document.createElement("div");

  private control?: ExplorerControlInstance;
  private paneId = "";
  private root = "/";

  constructor(private readonly deps: ExplorerPaneRendererDependencies) {
    this.element.className = "explorer-panel";
  }

  init(params: GroupPanelPartInitParameters) {
    this.paneId = params.api.id;
    const input = (params.params ?? {}) as ExplorerPaneParams;
    this.mount(optionalStringParam(input.root) ?? "/");
  }

  update(event: PanelUpdateEvent<ExplorerPaneParams>) {
    const nextRoot = optionalStringParam(event.params?.root) ?? "/";
    if (nextRoot === this.root) return;
    this.control?.dispose();
    this.mount(nextRoot);
  }

  focus() {
    this.control?.focus();
  }

  dispose() {
    this.control?.dispose();
    this.control = undefined;
    this.element.replaceChildren();
  }

  private mount(root: string) {
    this.root = root;
    this.element.replaceChildren();
    this.control = mountExplorerControl(this.element, {
      root,
      userLabel: this.deps.userLabel,
      listDir: async (path) => {
        const result = await this.deps.shellModel.pathCall("/fs/list", { path }, { sourcePaneId: this.paneId });
        if (!result.ok) {
          throw new Error(result.error);
        }
        return result.value as { entries: ExplorerEntry[] };
      },
      onActivate: (event) => {
        if (event.entry.kind !== "file") return;
        void this.deps.shellModel
          .pathCall(
            "/panes/new",
            {
              kind: "textEditor",
              path: event.path
            },
            { sourcePaneId: this.paneId }
          )
          .catch(() => {});
      },
      onCreateFile: (parent, name) => this.fsCall("/fs/create", { path: joinVirtual(parent, name) }),
      onCreateFolder: (parent, name) => this.fsCall("/fs/mkdir", { path: joinVirtual(parent, name) }),
      onRename: (path, newName) => this.fsCall("/fs/rename", { from: path, to: joinVirtual(parentOf(path), newName) }),
      onDelete: (path, isDir) => this.fsCall("/fs/delete", { path, recursive: isDir })
    });
  }

  // Single fs-mutation path: every UI trigger (header + context menu) routes
  // through the control's shared actions to one of these. Throws a code-carrying
  // error on failure so the control's banner maps it.
  private async fsCall(path: string, args: Record<string, unknown>): Promise<void> {
    const result = await this.deps.shellModel.pathCall(path, args, { sourcePaneId: this.paneId });
    if (!result.ok) {
      throw Object.assign(new Error(result.error), { code: result.code });
    }
  }
}

function joinVirtual(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent.replace(/\/+$/, "")}/${name}`;
}

function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

function optionalStringParam(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
