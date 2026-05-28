import type { GroupPanelPartInitParameters, IContentRenderer, PanelUpdateEvent } from "dockview-core";
import type { ShellModelAPI } from "@flmux/core/shell/types";
import {
  mountExplorerControl,
  type ExplorerControlInstance,
  type ExplorerEntry
} from "../controls/explorerControl";

interface ExplorerPaneRendererDependencies {
  shellModel: ShellModelAPI;
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
      }
    });
  }
}

function optionalStringParam(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
