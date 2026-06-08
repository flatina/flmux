import type { GroupPanelPartInitParameters, IContentRenderer, PanelUpdateEvent } from "dockview-core";
import type { ShellModelAPI } from "@flmux/core/shell/types";
import { mountExplorerControl, type ExplorerControlInstance, type ExplorerEntry } from "../controls/explorerControl";

interface ExplorerPaneRendererDependencies {
  shellModel: ShellModelAPI;
  userLabel?: string;
  /** Folder upload is web-only (server-side `/api/fs/upload`); desktop writes
   * the local fs directly, so the upload affordance is hidden there. */
  canUpload?: boolean;
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
      collapseSingleFolderRoot: true,
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
      onDelete: (path, isDir) => this.fsCall("/fs/delete", { path, recursive: isDir }),
      onPaste: ({ from, toParent, name, mode }) =>
        this.fsCall(mode === "copy" ? "/fs/copy" : "/fs/rename", { from, to: joinVirtual(toParent, name) }),
      onUpload: this.deps.canUpload ? (parent, files, ctx) => this.uploadFiles(parent, files, ctx) : undefined
    });
  }

  // POST each file to /api/fs/upload as an ordered chunk sequence (relative URL
  // → same-origin cookie auth); final chunk commits. 409 = already exists, skip
  // (idempotent re-drop). No resume — a failed file restarts from offset 0.
  private async uploadFiles(
    parent: string,
    files: readonly { relativePath: string; file: File }[],
    ctx: { report(done: number, total: number): void }
  ): Promise<void> {
    let done = 0;
    for (const { relativePath, file } of files) {
      // One id per file isolates its `.part` from concurrent/stale uploads.
      const uploadId = crypto.randomUUID().replace(/-/g, "");
      const url = `/api/fs/upload?path=${encodeURIComponent(joinVirtual(parent, relativePath))}&uploadId=${uploadId}`;
      let offset = 0;
      do {
        const end = Math.min(offset + UPLOAD_CHUNK_BYTES, file.size);
        const final = end >= file.size;
        const res = await fetch(`${url}&offset=${offset}&final=${final ? "1" : "0"}`, {
          method: "POST",
          body: file.slice(offset, end)
        });
        if (res.status === 409) break; // already exists — skip (idempotent re-drop)
        if (!res.ok) {
          const msg = await res
            .json()
            .then((b: { error?: string }) => b.error)
            .catch(() => res.statusText);
          throw new Error(`${relativePath}: ${msg}`);
        }
        offset = end;
      } while (offset < file.size);
      ctx.report(++done, files.length);
    }
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

// Per-request upload chunk — under the server's 4 MiB body cap, with headroom.
const UPLOAD_CHUNK_BYTES = 3 * 1024 * 1024;

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
