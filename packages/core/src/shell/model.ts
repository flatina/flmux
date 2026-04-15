import type {
  AppStatusSnapshot,
  NewPaneInput,
  PanePlacement,
  PathCallerContext,
  PathCallResult,
  PathErrorCode,
  PathGetResult,
  PathListResult,
  PathSetResult,
  ShellBrowserDelegate,
  ShellModelAPI,
  ShellModelHost,
  ShellPaneRecordSnapshot,
  ShellPathEntry,
  ShellTerminalDelegate
} from "./types";

export interface ShellModelDependencies {
  host: ShellModelHost;
  terminal: ShellTerminalDelegate;
  browser: ShellBrowserDelegate;
}

export function createShellModel(deps: ShellModelDependencies): ShellModelAPI {
  return new ShellModel(deps);
}

class ShellModel implements ShellModelAPI {
  private readonly host: ShellModelHost;
  private readonly terminal: ShellTerminalDelegate;
  private readonly browser: ShellBrowserDelegate;

  constructor(deps: ShellModelDependencies) {
    this.host = deps.host;
    this.terminal = deps.terminal;
    this.browser = deps.browser;
  }

  async pathGet(path: string): Promise<PathGetResult> {
    try {
      const segments = parsePath(path);
      return await this.getBySegments(segments);
    } catch (error) {
      return toPathGetError(error);
    }
  }

  async pathList(path: string): Promise<PathListResult> {
    try {
      const segments = parsePath(path);
      return await this.listBySegments(segments);
    } catch (error) {
      return toPathListError(error);
    }
  }

  async pathSet(path: string, value: unknown): Promise<PathSetResult> {
    try {
      const segments = parsePath(path);
      return await this.setBySegments(segments, value);
    } catch (error) {
      return toPathMutationError(error);
    }
  }

  async pathCall(path: string, args: Record<string, unknown> = {}, caller: PathCallerContext = {}): Promise<PathCallResult> {
    try {
      const segments = parsePath(path);
      return await this.callBySegments(segments, args, caller);
    } catch (error) {
      return toPathMutationError(error);
    }
  }

  private async getBySegments(segments: string[]): Promise<PathGetResult> {
    if (segments.length === 0) {
      return { ok: true, found: true, value: await this.getWorkspaceRootSnapshot() };
    }

    if (segments[0] === "app") {
      return await this.getApp(segments.slice(1));
    }

    if (segments[0] === "title") {
      const workspace = await this.host.getWorkspaceStatus();
      return segments.length === 1
        ? { ok: true, found: true, value: workspace.title }
        : notFoundGet();
    }

    if (segments[0] === "bus") {
      return await this.getBus(segments.slice(1));
    }

    if (segments[0] === "panes") {
      return await this.getPaneStatePath(segments.slice(1));
    }

    if (segments[0] === "status") {
      return await this.getStatusPath(segments.slice(1));
    }

    return notFoundGet();
  }

  private async listBySegments(segments: string[]): Promise<PathListResult> {
    if (segments.length === 0) {
      return {
        ok: true,
        found: true,
        entries: [
          leafEntry("title", "/title", true),
          objectEntry("bus", "/bus"),
          objectEntry("panes", "/panes"),
          objectEntry("status", "/status")
        ]
      };
    }

    if (segments[0] === "app") {
      return await this.listApp(segments.slice(1));
    }

    if (segments[0] === "title") {
      return throwPathError("INVALID_PATH", "Leaf path cannot be listed");
    }

    if (segments[0] === "bus") {
      return await this.listBus(segments.slice(1));
    }

    if (segments[0] === "panes") {
      return await this.listPaneStatePath(segments.slice(1));
    }

    if (segments[0] === "status") {
      return await this.listStatusPath(segments.slice(1));
    }

    return notFoundList();
  }

  private async setBySegments(segments: string[], value: unknown): Promise<PathSetResult> {
    if (segments.length === 0 || segments[0] === "status" || segments[0] === "bus") {
      return throwPathError("NOT_WRITABLE", "Path is read-only");
    }

    if (segments[0] === "app") {
      if (segments.length === 2 && segments[1] === "title") {
        const appStatus = await this.host.setAppTitle(asNonEmptyString(value, "App title"));
        return {
          ok: true,
          value: appStatus.title
        };
      }

      return throwPathError("NOT_WRITABLE", "Path is not writable");
    }

    if (segments[0] === "title") {
      if (segments.length !== 1) {
        return throwPathError("NOT_WRITABLE", "Path is not writable");
      }

      const workspaceStatus = await this.host.setWorkspaceTitle(asNonEmptyString(value, "Workspace title"));
      return {
        ok: true,
        value: workspaceStatus.title
      };
    }

    if (segments[0] === "panes") {
      const paneSegment = segments[1];
      if (!paneSegment) {
        return throwPathError("NOT_WRITABLE", "Pane collection is not writable");
      }

      const pane = await this.resolvePane(paneSegment);
      if (!pane) {
        return throwPathError("NOT_FOUND", `Pane '${paneSegment}' not found`);
      }

      if (segments.length === 3 && segments[2] === "title") {
        const updatedPane = await this.host.setPaneTitle(pane.id, asNonEmptyString(value, "Pane title"));
        return {
          ok: true,
          value: updatedPane.title
        };
      }

      if (segments.length === 4 && segments[2] === "browser" && segments[3] === "url") {
        if (pane.kind !== "browser") {
          return throwPathError("NOT_WRITABLE", "Only browser panes expose a writable browser/url");
        }

        const updatedPane = await this.browser.setPaneUrl(pane.id, asNonEmptyString(value, "Pane url"));
        return {
          ok: true,
          value: readBrowserUrl(updatedPane)
        };
      }

      const mount = await this.host.getPanePathMount(pane.id);
      if (mount && segments[2] === mount.mountKey) {
        return await this.setPaneMountStatePath(pane.id, mount, segments.slice(3), value);
      }

      return throwPathError("NOT_WRITABLE", "Path is not writable");
    }

    return throwPathError("NOT_WRITABLE", "Path is not writable");
  }

  private async callBySegments(
    segments: string[],
    args: Record<string, unknown>,
    caller: PathCallerContext
  ): Promise<PathCallResult> {
    if (segments.length === 0 || segments[0] === "app" || segments[0] === "title" || segments[0] === "status") {
      return throwPathError("NOT_CALLABLE", "Path is not callable");
    }

    if (segments[0] === "bus") {
      if (segments.length === 2 && segments[1] === "publish") {
        const sourcePaneId = caller.sourcePaneId;
        if (!sourcePaneId) {
          return throwPathError("INVALID_VALUE", "call /bus/publish requires runtime caller context");
        }

        const { topic, payload } = parsePublishArgs(args);
        const event = await this.host.publishWorkspaceEvent({
          topic,
          payload,
          sourcePaneId
        });

        return {
          ok: true,
          value: {
            ok: true,
            published: event
          }
        };
      }

      return throwPathError("NOT_CALLABLE", "Path is not callable");
    }

    if (segments[0] !== "panes") {
      return throwPathError("NOT_CALLABLE", "Path is not callable");
    }

    if (segments.length === 2 && segments[1] === "new") {
      const input = parseNewPaneArgs(args);
      if (!(await this.host.hasPaneKind(input.kind))) {
        return throwPathError("INVALID_VALUE", `Unsupported pane kind '${input.kind}'`);
      }

      const pane = await this.host.createPane(input);
      return {
        ok: true,
        value: {
          paneId: pane.id,
          path: `/panes/${pane.id}`,
          pane: toPaneStatusSnapshot(pane)
        }
      };
    }

    const paneSegment = segments[1];
    if (!paneSegment) {
      return throwPathError("NOT_CALLABLE", "Pane collection is not callable");
    }

    const pane = await this.resolvePane(paneSegment);
    if (!pane) {
      return throwPathError("NOT_FOUND", `Pane '${paneSegment}' not found`);
    }

    if (segments.length >= 3 && segments[2] === "terminal") {
      if (pane.kind !== "terminal") {
        return throwPathError("NOT_CALLABLE", "Terminal actions only apply to terminal panes");
      }

      if (segments.length === 4 && segments[3] === "create") {
        if (readTerminalRuntimeId(pane) !== null) {
          return throwPathError("INVALID_VALUE", "Terminal pane already has an attached runtime");
        }

        const result = await this.terminal.createRuntime(pane.id, {
          cwd: optionalString(args.cwd)
        });
        return { ok: true, value: result };
      }

      if (segments.length === 4 && segments[3] === "write") {
        if (readTerminalRuntimeId(pane) === null) {
          return throwPathError("INVALID_VALUE", "Terminal pane is not attached to a runtime");
        }

        const data = optionalString(args.data);
        if (!data) {
          return throwPathError("INVALID_VALUE", "terminal write requires data=...");
        }

        const result = await this.terminal.writeRuntime(pane.id, { data });
        return { ok: true, value: result };
      }

      if (segments.length === 4 && segments[3] === "resize") {
        if (readTerminalRuntimeId(pane) === null) {
          return throwPathError("INVALID_VALUE", "Terminal pane is not attached to a runtime");
        }

        const cols = asPositiveInteger(args.cols, "cols");
        const rows = asPositiveInteger(args.rows, "rows");
        const result = await this.terminal.resizeRuntime(pane.id, { cols, rows });
        return { ok: true, value: result };
      }

      if (segments.length === 4 && segments[3] === "history") {
        if (readTerminalRuntimeId(pane) === null) {
          return throwPathError("INVALID_VALUE", "Terminal pane is not attached to a runtime");
        }

        const maxBytes = typeof args.maxBytes === "number" ? args.maxBytes : undefined;
        const result = await this.terminal.readHistory(pane.id, { maxBytes });
        return { ok: true, value: result };
      }

      if (segments.length === 4 && segments[3] === "kill") {
        if (readTerminalRuntimeId(pane) === null) {
          return throwPathError("INVALID_VALUE", "Terminal pane is not attached to a runtime");
        }

        const result = await this.terminal.killRuntime(pane.id);
        return { ok: true, value: result };
      }

      return throwPathError("NOT_CALLABLE", "Path is not callable");
    }

    if (segments.length === 3 && segments[2] === "close") {
      return {
        ok: true,
        value: await this.host.closePane(pane.id)
      };
    }

    return throwPathError("NOT_CALLABLE", "Path is not callable");
  }

  private async getApp(segments: string[]): Promise<PathGetResult> {
    const appStatus = await this.host.getAppStatus();

    if (segments.length === 0) {
      return {
        ok: true,
        found: true,
        value: { title: appStatus.title }
      };
    }

    if (segments.length === 1 && segments[0] === "title") {
      return { ok: true, found: true, value: appStatus.title };
    }

    return notFoundGet();
  }

  private async listApp(segments: string[]): Promise<PathListResult> {
    if (segments.length === 0) {
      return {
        ok: true,
        found: true,
        entries: [leafEntry("title", "/app/title", true)]
      };
    }

    if (segments.length === 1 && segments[0] === "title") {
      return throwPathError("INVALID_PATH", "Leaf path cannot be listed");
    }

    return notFoundList();
  }

  private async getPaneStatePath(segments: string[]): Promise<PathGetResult> {
    if (segments.length === 0) {
      const panes = await this.host.listPanes();
      return {
        ok: true,
        found: true,
        value: Object.fromEntries(
          panes.map((pane) => [pane.id, toPaneStateSnapshot(pane)])
        )
      };
    }

    const pane = await this.resolvePane(segments[0]);
    if (!pane) {
      return notFoundGet();
    }

    if (segments.length === 1) {
      return { ok: true, found: true, value: toPaneStateSnapshot(pane) };
    }

    if (segments.length === 2 && segments[1] === "kind") {
      return { ok: true, found: true, value: pane.kind };
    }

    if (segments.length === 2 && segments[1] === "title") {
      return { ok: true, found: true, value: pane.title };
    }

    if (segments.length === 2 && segments[1] === "browser" && pane.kind === "browser") {
      return {
        ok: true,
        found: true,
        value: toBrowserStateSnapshot(pane)
      };
    }

    if (segments.length === 3 && segments[1] === "browser" && segments[2] === "url" && pane.kind === "browser") {
      return { ok: true, found: true, value: readBrowserUrl(pane) };
    }

    if (segments.length === 2 && segments[1] === "terminal" && pane.kind === "terminal") {
      return {
        ok: true,
        found: true,
        value: toTerminalStateSnapshot(pane)
      };
    }

    if (segments.length === 3 && segments[1] === "terminal" && pane.kind === "terminal") {
      const terminal = toTerminalStateSnapshot(pane);
      if (segments[2] === "cwd") {
        return {
          ok: true,
          found: true,
          value: terminal[segments[2]]
        };
      }

      if (
        segments[2] === "create" ||
        segments[2] === "write" ||
        segments[2] === "resize" ||
        segments[2] === "history" ||
        segments[2] === "kill"
      ) {
        return throwPathError("INVALID_PATH", "Action path cannot be read");
      }
    }

    if (segments.length === 2 && segments[1] === "close") {
      return throwPathError("INVALID_PATH", "Action path cannot be read");
    }

    const mount = await this.host.getPanePathMount(pane.id);
    if (mount && segments[1] === mount.mountKey) {
      return await this.getPaneMountPath(mount, segments.slice(2), "state");
    }

    return notFoundGet();
  }

  private async listPaneStatePath(segments: string[]): Promise<PathListResult> {
    if (segments.length === 0) {
      const panes = await this.host.listPanes();
      return {
        ok: true,
        found: true,
        entries: panes.map((pane) => objectEntry(pane.id, `/panes/${pane.id}`))
      };
    }

    const pane = await this.resolvePane(segments[0]);
    if (!pane) {
      return notFoundList();
    }

    if (segments.length === 1) {
      const mount = await this.host.getPanePathMount(pane.id);
      return {
        ok: true,
        found: true,
        entries: withMountEntry(paneStateEntries(pane, `/panes/${segments[0]}`), mount, `/panes/${segments[0]}`)
      };
    }

    if (segments.length === 2) {
      if (segments[1] === "kind" || segments[1] === "title") {
        return throwPathError("INVALID_PATH", "Leaf path cannot be listed");
      }

      if (segments[1] === "browser" && pane.kind === "browser") {
        return {
          ok: true,
          found: true,
          entries: [leafEntry("url", `/panes/${segments[0]}/browser/url`, true)]
        };
      }

      if (segments[1] === "terminal" && pane.kind === "terminal") {
        return {
          ok: true,
          found: true,
          entries: [
            leafEntry("cwd", `/panes/${segments[0]}/terminal/cwd`),
            actionEntry("create", `/panes/${segments[0]}/terminal/create`),
            actionEntry("write", `/panes/${segments[0]}/terminal/write`),
            actionEntry("resize", `/panes/${segments[0]}/terminal/resize`),
            actionEntry("history", `/panes/${segments[0]}/terminal/history`),
            actionEntry("kill", `/panes/${segments[0]}/terminal/kill`)
          ]
        };
      }

      if (segments[1] === "close") {
        return throwPathError("INVALID_PATH", "Action path cannot be listed");
      }
    }

    const mount = await this.host.getPanePathMount(pane.id);
    if (mount && segments[1] === mount.mountKey) {
      return await this.listPaneMountPath(mount, segments.slice(2), `/panes/${segments[0]}/${mount.mountKey}`, "state");
    }

    return notFoundList();
  }

  private async getStatusPath(segments: string[]): Promise<PathGetResult> {
    if (segments.length === 0) {
      const app = await this.host.getAppStatus();
      const workspace = await this.host.getWorkspaceStatus();
      const panes = await this.host.listPanes();
      return {
        ok: true,
        found: true,
        value: {
          app,
          workspace,
          panes: Object.fromEntries(
            panes.map((pane) => [pane.id, toPaneStatusSnapshot(pane)])
          )
        }
      };
    }

    if (segments[0] === "app") {
      return await this.getStatusApp(segments.slice(1));
    }

    if (segments[0] === "workspace") {
      return await this.getStatusWorkspace(segments.slice(1));
    }

    if (segments[0] === "panes") {
      return await this.getStatusPanes(segments.slice(1));
    }

    return notFoundGet();
  }

  private async listStatusPath(segments: string[]): Promise<PathListResult> {
    if (segments.length === 0) {
      return {
        ok: true,
        found: true,
        entries: [
          objectEntry("app", "/status/app"),
          objectEntry("workspace", "/status/workspace"),
          objectEntry("panes", "/status/panes")
        ]
      };
    }

    if (segments[0] === "app") {
      return await this.listStatusApp(segments.slice(1));
    }

    if (segments[0] === "workspace") {
      return await this.listStatusWorkspace(segments.slice(1));
    }

    if (segments[0] === "panes") {
      return await this.listStatusPanes(segments.slice(1));
    }

    return notFoundList();
  }

  private async getStatusApp(segments: string[]): Promise<PathGetResult> {
    const appStatus = await this.host.getAppStatus();

    if (segments.length === 0) {
      return { ok: true, found: true, value: appStatus };
    }

    if (segments.length === 1 && isAppStatusKey(segments[0])) {
      return { ok: true, found: true, value: appStatus[segments[0]] };
    }

    return notFoundGet();
  }

  private async listStatusApp(segments: string[]): Promise<PathListResult> {
    if (segments.length === 0) {
      return {
        ok: true,
        found: true,
        entries: [
          leafEntry("title", "/status/app/title"),
          leafEntry("origin", "/status/app/origin"),
          leafEntry("runtimeLabel", "/status/app/runtimeLabel")
        ]
      };
    }

    if (segments.length === 1 && isAppStatusKey(segments[0])) {
      return throwPathError("INVALID_PATH", "Leaf path cannot be listed");
    }

    return notFoundList();
  }

  private async getStatusWorkspace(segments: string[]): Promise<PathGetResult> {
    const workspaceStatus = await this.host.getWorkspaceStatus();

    if (segments.length === 0) {
      return { ok: true, found: true, value: workspaceStatus };
    }

    if (segments.length === 1 && isWorkspaceStatusKey(segments[0])) {
      return { ok: true, found: true, value: workspaceStatus[segments[0]] };
    }

    return notFoundGet();
  }

  private async listStatusWorkspace(segments: string[]): Promise<PathListResult> {
    if (segments.length === 0) {
      return {
        ok: true,
        found: true,
        entries: [
          leafEntry("id", "/status/workspace/id"),
          leafEntry("title", "/status/workspace/title"),
          leafEntry("activePaneId", "/status/workspace/activePaneId"),
          leafEntry("paneCount", "/status/workspace/paneCount")
        ]
      };
    }

    if (segments.length === 1 && isWorkspaceStatusKey(segments[0])) {
      return throwPathError("INVALID_PATH", "Leaf path cannot be listed");
    }

    return notFoundList();
  }

  private async getStatusPanes(segments: string[]): Promise<PathGetResult> {
    if (segments.length === 0) {
      const panes = await this.host.listPanes();
      return {
        ok: true,
        found: true,
        value: Object.fromEntries(
          panes.map((pane) => [pane.id, toPaneStatusSnapshot(pane)])
        )
      };
    }

    const pane = await this.resolvePane(segments[0]);
    if (!pane) {
      return notFoundGet();
    }

    const status = toPaneStatusSnapshot(pane);
    if (segments.length === 1) {
      return { ok: true, found: true, value: status };
    }

    if (segments.length === 2 && segments[1] === "browser" && pane.kind === "browser") {
      return {
        ok: true,
        found: true,
        value: toBrowserStatusSnapshot(pane)
      };
    }

    if (segments.length === 2 && segments[1] === "terminal" && pane.kind === "terminal") {
      return {
        ok: true,
        found: true,
        value: toTerminalStatusSnapshot(pane)
      };
    }

    if (segments.length === 2 && isPaneStatusLeaf(segments[1])) {
      return { ok: true, found: true, value: status[segments[1]] };
    }

    if (segments.length === 3 && segments[1] === "browser" && segments[2] === "url" && pane.kind === "browser") {
      return {
        ok: true,
        found: true,
        value: readBrowserUrl(pane)
      };
    }

    if (segments.length === 3 && segments[1] === "terminal" && pane.kind === "terminal") {
      const terminal = toTerminalStatusSnapshot(pane);
      if (
        segments[2] === "attached" ||
        segments[2] === "rootKey" ||
        segments[2] === "cwd" ||
        segments[2] === "runtimeId" ||
        segments[2] === "alive" ||
        segments[2] === "commandCount" ||
        segments[2] === "createdAt" ||
        segments[2] === "updatedAt"
      ) {
        return {
          ok: true,
          found: true,
          value: terminal[segments[2]]
        };
      }
    }

    const mount = await this.host.getPanePathMount(pane.id);
    if (mount && segments[1] === mount.mountKey) {
      return await this.getPaneMountPath(mount, segments.slice(2), "status");
    }

    return notFoundGet();
  }

  private async listStatusPanes(segments: string[]): Promise<PathListResult> {
    if (segments.length === 0) {
      const panes = await this.host.listPanes();
      return {
        ok: true,
        found: true,
        entries: panes.map((pane) => objectEntry(pane.id, `/status/panes/${pane.id}`))
      };
    }

    const pane = await this.resolvePane(segments[0]);
    if (!pane) {
      return notFoundList();
    }

    if (segments.length === 1) {
      const mount = await this.host.getPanePathMount(pane.id);
      return {
        ok: true,
        found: true,
        entries: withMountEntry(paneStatusEntries(pane, `/status/panes/${segments[0]}`), mount, `/status/panes/${segments[0]}`)
      };
    }

    if (segments.length === 2 && segments[1] === "browser" && pane.kind === "browser") {
      return {
        ok: true,
        found: true,
        entries: [leafEntry("url", `/status/panes/${segments[0]}/browser/url`)]
      };
    }

    if (segments.length === 2 && segments[1] === "terminal" && pane.kind === "terminal") {
      return {
        ok: true,
        found: true,
        entries: [
          leafEntry("attached", `/status/panes/${segments[0]}/terminal/attached`),
          leafEntry("rootKey", `/status/panes/${segments[0]}/terminal/rootKey`),
          leafEntry("cwd", `/status/panes/${segments[0]}/terminal/cwd`),
          leafEntry("runtimeId", `/status/panes/${segments[0]}/terminal/runtimeId`),
          leafEntry("alive", `/status/panes/${segments[0]}/terminal/alive`),
          leafEntry("commandCount", `/status/panes/${segments[0]}/terminal/commandCount`),
          leafEntry("createdAt", `/status/panes/${segments[0]}/terminal/createdAt`),
          leafEntry("updatedAt", `/status/panes/${segments[0]}/terminal/updatedAt`)
        ]
      };
    }

    if (segments.length === 2 && isPaneStatusLeaf(segments[1])) {
      return throwPathError("INVALID_PATH", "Leaf path cannot be listed");
    }

    const mount = await this.host.getPanePathMount(pane.id);
    if (mount && segments[1] === mount.mountKey) {
      return await this.listPaneMountPath(
        mount,
        segments.slice(2),
        `/status/panes/${segments[0]}/${mount.mountKey}`,
        "status"
      );
    }

    return notFoundList();
  }

  private async getPaneMountPath(
    mount: Awaited<ReturnType<ShellModelHost["getPanePathMount"]>>,
    relativePath: string[],
    scope: "state" | "status"
  ): Promise<PathGetResult> {
    const snapshot = scope === "state" ? await mount?.getStateSnapshot() : await mount?.getStatusSnapshot();
    if (!snapshot) {
      return notFoundGet();
    }

    if (relativePath.length === 0) {
      return { ok: true, found: true, value: snapshot };
    }

    const resolved = readSnapshotPath(snapshot, relativePath);
    return resolved.found
      ? { ok: true, found: true, value: resolved.value }
      : notFoundGet();
  }

  private async listPaneMountPath(
    mount: Awaited<ReturnType<ShellModelHost["getPanePathMount"]>>,
    relativePath: string[],
    basePath: string,
    scope: "state" | "status"
  ): Promise<PathListResult> {
    const snapshot = scope === "state" ? await mount?.getStateSnapshot() : await mount?.getStatusSnapshot();
    if (!snapshot) {
      return notFoundList();
    }

    const resolved = relativePath.length === 0
      ? { found: true, value: snapshot }
      : readSnapshotPath(snapshot, relativePath);
    if (!resolved.found) {
      return notFoundList();
    }

    const target = resolved.value;
    if (!isPlainObject(target)) {
      return throwPathError("INVALID_PATH", "Leaf path cannot be listed");
    }

    return {
      ok: true,
      found: true,
      entries: await snapshotEntries(
        target,
        relativePath.length === 0 ? basePath : `${basePath}/${relativePath.join("/")}`,
        relativePath,
        scope === "state" ? mount?.canSetStatePath : undefined
      )
    };
  }

  private async setPaneMountStatePath(
    paneId: string,
    mount: Awaited<ReturnType<ShellModelHost["getPanePathMount"]>>,
    relativePath: string[],
    value: unknown
  ): Promise<PathSetResult> {
    if (!mount?.setState || relativePath.length === 0) {
      return throwPathError("NOT_WRITABLE", "Path is not writable");
    }

    const snapshot = await mount.getStateSnapshot();
    if (!snapshot) {
      return throwPathError("NOT_WRITABLE", "Path is not writable");
    }

    const resolved = readSnapshotPath(snapshot, relativePath);
    if (!resolved.found || isPlainObject(resolved.value)) {
      return throwPathError("NOT_WRITABLE", "Path is not writable");
    }

    if (!(await mount.canSetStatePath?.(relativePath) ?? false)) {
      return throwPathError("NOT_WRITABLE", "Path is not writable");
    }

    const result = await mount.setState(relativePath, value);
    return { ok: true, value: result.value };
  }

  private async getWorkspaceRootSnapshot() {
    const workspace = await this.host.getWorkspaceStatus();
    const panes = await this.host.listPanes();
    const app = await this.host.getAppStatus();
    return {
      title: workspace.title,
      bus: {},
      panes: Object.fromEntries(
        panes.map((pane) => [pane.id, toPaneStateSnapshot(pane)])
      ),
      status: {
        app,
        workspace,
        panes: Object.fromEntries(
          panes.map((pane) => [pane.id, toPaneStatusSnapshot(pane)])
        )
      }
    };
  }

  private async resolvePane(paneSegment: string): Promise<ShellPaneRecordSnapshot | undefined> {
    if (paneSegment === "current") {
      const activePaneId = (await this.host.getWorkspaceStatus()).activePaneId;
      if (!activePaneId) {
        throw new ModelPathError("NO_CURRENT_PANE", "No active pane is available");
      }

      return this.host.getPane(activePaneId);
    }

    return this.host.getPane(paneSegment);
  }

  private async getBus(segments: string[]): Promise<PathGetResult> {
    if (segments.length === 0) {
      return { ok: true, found: true, value: {} };
    }

    if (segments.length === 1 && segments[0] === "publish") {
      return throwPathError("INVALID_PATH", "Action path cannot be read");
    }

    return notFoundGet();
  }

  private async listBus(segments: string[]): Promise<PathListResult> {
    if (segments.length === 0) {
      return {
        ok: true,
        found: true,
        entries: [actionEntry("publish", "/bus/publish")]
      };
    }

    if (segments.length === 1 && segments[0] === "publish") {
      return throwPathError("INVALID_PATH", "Action path cannot be listed");
    }

    return notFoundList();
  }
}

class ModelPathError extends Error {
  constructor(
    readonly code: PathErrorCode,
    message: string
  ) {
    super(message);
  }
}

function parsePath(path: string): string[] {
  if (!path.startsWith("/")) {
    throw new ModelPathError("INVALID_PATH", "Path must start with '/'");
  }

  const segments = path.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new ModelPathError("INVALID_PATH", "Relative path segments are not allowed");
  }

  return segments;
}

function parseNewPaneArgs(args: Record<string, unknown>): NewPaneInput {
  const kind = optionalString(args.kind);
  if (!kind) {
    throw new ModelPathError("INVALID_VALUE", "call /panes/new requires kind=...");
  }

  const place = normalizePlacement(args.place);
  const title = optionalString(args.title);
  const url = optionalString(args.url);
  const cwd = optionalString(args.cwd);
  const referencePaneId = optionalString(args.referencePaneId);
  const params = Object.fromEntries(
    Object.entries(args).filter(([key]) => (
      key !== "kind" &&
      key !== "title" &&
      key !== "url" &&
      key !== "cwd" &&
      key !== "place" &&
      key !== "referencePaneId"
    ))
  );

  return {
    kind,
    title,
    url,
    cwd,
    params: Object.keys(params).length > 0 ? params : undefined,
    place,
    referencePaneId
  };
}

function parsePublishArgs(args: Record<string, unknown>) {
  const topic = optionalString(args.topic);
  if (!topic) {
    throw new ModelPathError("INVALID_VALUE", "call /bus/publish requires topic=...");
  }

  if ("payload" in args) {
    const extraKeys = Object.keys(args).filter((key) => key !== "topic" && key !== "payload");
    if (extraKeys.length > 0) {
      throw new ModelPathError(
        "INVALID_VALUE",
        "call /bus/publish accepts either payload=... or named payload fields, not both"
      );
    }

    return {
      topic,
      payload: args.payload
    };
  }

  const payloadEntries = Object.entries(args).filter(([key]) => key !== "topic");
  return {
    topic,
    payload:
      payloadEntries.length === 0
        ? null
        : Object.fromEntries(payloadEntries)
  };
}

function normalizePlacement(value: unknown): PanePlacement | undefined {
  const place = optionalString(value);
  if (!place) {
    return undefined;
  }

  if (place === "within" || place === "left" || place === "right" || place === "above" || place === "below") {
    return place;
  }

  throw new ModelPathError("INVALID_VALUE", `Unsupported pane placement '${place}'`);
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new ModelPathError("INVALID_VALUE", "Expected a string value");
  }

  return value;
}

function asNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new ModelPathError("INVALID_VALUE", `${label} must be a string`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new ModelPathError("INVALID_VALUE", `${label} cannot be empty`);
  }

  return trimmed;
}

function asPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ModelPathError("INVALID_VALUE", `${label} must be a positive integer`);
  }

  return value;
}

function toPaneStateSnapshot(pane: ShellPaneRecordSnapshot) {
  return pane.kind === "browser"
    ? { kind: pane.kind, title: pane.title, browser: toBrowserStateSnapshot(pane) }
    : pane.kind === "terminal"
      ? {
          kind: pane.kind,
          title: pane.title,
          terminal: toTerminalStateSnapshot(pane)
        }
    : { kind: pane.kind, title: pane.title };
}

function toPaneStatusSnapshot(pane: ShellPaneRecordSnapshot) {
  return pane.kind === "browser"
    ? {
        id: pane.id,
        kind: pane.kind,
        title: pane.title,
        active: pane.active,
        browser: toBrowserStatusSnapshot(pane)
      }
    : pane.kind === "terminal"
      ? {
          id: pane.id,
          kind: pane.kind,
          title: pane.title,
          active: pane.active,
          terminal: toTerminalStatusSnapshot(pane)
        }
    : { id: pane.id, kind: pane.kind, title: pane.title, active: pane.active };
}

function paneStateEntries(pane: ShellPaneRecordSnapshot, basePath: string): ShellPathEntry[] {
  return pane.kind === "browser"
    ? [
        leafEntry("kind", `${basePath}/kind`),
        leafEntry("title", `${basePath}/title`, true),
        objectEntry("browser", `${basePath}/browser`),
        actionEntry("close", `${basePath}/close`)
      ]
    : pane.kind === "terminal"
      ? [
          leafEntry("kind", `${basePath}/kind`),
          leafEntry("title", `${basePath}/title`, true),
          objectEntry("terminal", `${basePath}/terminal`),
          actionEntry("close", `${basePath}/close`)
        ]
    : [
        leafEntry("kind", `${basePath}/kind`),
        leafEntry("title", `${basePath}/title`, true),
        actionEntry("close", `${basePath}/close`)
      ];
}

function paneStatusEntries(pane: ShellPaneRecordSnapshot, basePath: string): ShellPathEntry[] {
  return pane.kind === "browser"
    ? [
        leafEntry("id", `${basePath}/id`),
        leafEntry("kind", `${basePath}/kind`),
        leafEntry("title", `${basePath}/title`),
        leafEntry("active", `${basePath}/active`),
        objectEntry("browser", `${basePath}/browser`)
      ]
    : pane.kind === "terminal"
      ? [
          leafEntry("id", `${basePath}/id`),
          leafEntry("kind", `${basePath}/kind`),
          leafEntry("title", `${basePath}/title`),
          leafEntry("active", `${basePath}/active`),
          objectEntry("terminal", `${basePath}/terminal`)
        ]
    : [
        leafEntry("id", `${basePath}/id`),
        leafEntry("kind", `${basePath}/kind`),
        leafEntry("title", `${basePath}/title`),
        leafEntry("active", `${basePath}/active`)
      ];
}

function leafEntry(name: string, path: string, writable = false): ShellPathEntry {
  return { name, path, kind: "leaf", writable };
}

function objectEntry(name: string, path: string): ShellPathEntry {
  return { name, path, kind: "object", writable: false };
}

function actionEntry(name: string, path: string): ShellPathEntry {
  return { name, path, kind: "action", writable: false };
}

function isAppStatusKey(value: string): value is keyof AppStatusSnapshot {
  return value === "title" || value === "origin" || value === "runtimeLabel";
}

function isWorkspaceStatusKey(value: string): value is keyof ReturnType<ShellModelHost["getWorkspaceStatus"]> {
  return value === "id" || value === "title" || value === "activePaneId" || value === "paneCount";
}

function isPaneStatusKey(value: string): value is keyof ReturnType<typeof toPaneStatusSnapshot> {
  return value === "id" || value === "kind" || value === "title" || value === "active";
}

function isPaneStatusLeaf(value: string): value is keyof ReturnType<typeof toPaneStatusSnapshot> {
  return isPaneStatusKey(value);
}

function toBrowserStateSnapshot(pane: ShellPaneRecordSnapshot) {
  return {
    url: readBrowserUrl(pane)
  };
}

function toBrowserStatusSnapshot(pane: ShellPaneRecordSnapshot) {
  return {
    url: readBrowserUrl(pane)
  };
}

function readBrowserUrl(pane: ShellPaneRecordSnapshot) {
  return pane.browser?.url ?? "";
}

function toTerminalStateSnapshot(pane: ShellPaneRecordSnapshot) {
  return {
    cwd: readTerminalStatus(pane).cwd
  };
}

function toTerminalStatusSnapshot(pane: ShellPaneRecordSnapshot) {
  const terminal = readTerminalStatus(pane);
  return {
    attached: terminal.attached,
    rootKey: terminal.rootKey,
    cwd: terminal.cwd,
    runtimeId: terminal.runtimeId,
    alive: terminal.alive,
    commandCount: terminal.commandCount,
    createdAt: terminal.createdAt,
    updatedAt: terminal.updatedAt
  };
}

function readTerminalStatus(pane: ShellPaneRecordSnapshot) {
  return {
    attached: pane.terminal?.attached ?? false,
    rootKey: pane.terminal?.rootKey ?? null,
    cwd: pane.terminal?.cwd ?? "",
    runtimeId: pane.terminal?.runtimeId ?? null,
    alive: pane.terminal?.alive ?? null,
    commandCount: pane.terminal?.commandCount ?? null,
    createdAt: pane.terminal?.createdAt ?? null,
    updatedAt: pane.terminal?.updatedAt ?? null
  };
}

function readTerminalRuntimeId(pane: ShellPaneRecordSnapshot) {
  return readTerminalStatus(pane).runtimeId;
}

function withMountEntry(
  entries: ShellPathEntry[],
  mount: Awaited<ReturnType<ShellModelHost["getPanePathMount"]>>,
  basePath: string
) {
  return mount
    ? [
        ...entries,
        objectEntry(mount.mountKey, `${basePath}/${mount.mountKey}`)
      ]
    : entries;
}

function readSnapshotPath(snapshot: Record<string, unknown>, relativePath: string[]) {
  let current: unknown = snapshot;
  for (const segment of relativePath) {
    if (!isPlainObject(current) || !(segment in current)) {
      return { found: false, value: undefined };
    }

    current = current[segment];
  }

  return { found: true, value: current };
}

async function snapshotEntries(
  snapshot: Record<string, unknown>,
  basePath: string,
  relativePath: string[],
  canSetStatePath: ((relativePath: string[]) => Promise<boolean> | boolean) | undefined
): Promise<ShellPathEntry[]> {
  return await Promise.all(
    Object.entries(snapshot).map(async ([name, value]) =>
      isPlainObject(value)
        ? objectEntry(name, `${basePath}/${name}`)
        : leafEntry(
            name,
            `${basePath}/${name}`,
            canSetStatePath ? await canSetStatePath([...relativePath, name]) : false
          )
    )
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function notFoundGet(): PathGetResult {
  return { ok: true, found: false, value: null };
}

function notFoundList(): PathListResult {
  return { ok: true, found: false, entries: [] };
}

function toPathGetError(error: unknown): PathGetResult {
  if (error instanceof ModelPathError) {
    return { ok: false, code: error.code, error: error.message };
  }

  return { ok: false, code: "INTERNAL_ERROR", error: String(error) };
}

function toPathListError(error: unknown): PathListResult {
  if (error instanceof ModelPathError) {
    return { ok: false, code: error.code, error: error.message };
  }

  return { ok: false, code: "INTERNAL_ERROR", error: String(error) };
}

function toPathMutationError(error: unknown): PathSetResult & PathCallResult {
  if (error instanceof ModelPathError) {
    return { ok: false, code: error.code, error: error.message };
  }

  return { ok: false, code: "INTERNAL_ERROR", error: String(error) };
}

function throwPathError<T>(code: PathErrorCode, message: string): T {
  throw new ModelPathError(code, message);
}
