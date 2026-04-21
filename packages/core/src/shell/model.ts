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
  ShellModelAPI,
  ShellModelHost,
  ShellPaneRecordSnapshot,
  ShellPathEntry,
  ShellResolvedPaneSubtreeMount,
  ScopedPropertyTarget,
  ShellTerminalDelegate
} from "./types";

export interface ShellModelDependencies {
  host: ShellModelHost;
  terminal: ShellTerminalDelegate;
}

export function createShellModel(deps: ShellModelDependencies): ShellModelAPI {
  return new ShellModel(deps);
}

class ShellModel implements ShellModelAPI {
  private readonly host: ShellModelHost;
  private readonly terminal: ShellTerminalDelegate;

  constructor(deps: ShellModelDependencies) {
    this.host = deps.host;
    this.terminal = deps.terminal;
  }

  async pathGet(path: string, caller: PathCallerContext = {}): Promise<PathGetResult> {
    try {
      const segments = parsePath(path);
      return await this.getBySegments(segments, caller);
    } catch (error) {
      return toPathGetError(error);
    }
  }

  async pathList(path: string, caller: PathCallerContext = {}): Promise<PathListResult> {
    try {
      const segments = parsePath(path);
      return await this.listBySegments(segments, caller);
    } catch (error) {
      return toPathListError(error);
    }
  }

  async pathSet(path: string, value: unknown, caller: PathCallerContext = {}): Promise<PathSetResult> {
    try {
      const segments = parsePath(path);
      return await this.setBySegments(segments, value, caller);
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

  private async getBySegments(segments: string[], caller: PathCallerContext): Promise<PathGetResult> {
    if (segments.length === 0) {
      return { ok: true, found: true, value: await this.getWorkspaceRootSnapshot(caller) };
    }

    if (segments[0] === "app") {
      return await this.getApp(segments.slice(1));
    }

    const rootProperty = getWorkspaceStatePropertyByAlias(segments[0]);
    if (rootProperty) {
      if (segments.length !== 1) {
        return notFoundGet();
      }

      const slotKey = requireSlotKey(caller, `/${segments[0]}`, "/workspaces/{id}");
      const workspace = await this.host.getWorkspaceStatus({ slotKey });
      return {
        ok: true,
        found: true,
        value: rootProperty.read(workspace)
      };
    }

    if (segments[0] === "workspaces") {
      return await this.getWorkspaces(segments.slice(1));
    }

    if (segments[0] === "bus") {
      return await this.getBus(segments.slice(1));
    }

    if (segments[0] === "panes") {
      return await this.getPaneStatePath(segments.slice(1), caller);
    }

    if (segments[0] === "status") {
      return await this.getStatusPath(segments.slice(1), caller);
    }

    return notFoundGet();
  }

  private async listBySegments(segments: string[], caller: PathCallerContext): Promise<PathListResult> {
    if (segments.length === 0) {
      return {
        ok: true,
        found: true,
        entries: [
          ...workspaceRootAliasEntries(),
          objectEntry("workspaces", "/workspaces"),
          objectEntry("bus", "/bus"),
          objectEntry("panes", "/panes"),
          objectEntry("status", "/status")
        ]
      };
    }

    if (segments[0] === "app") {
      return await this.listApp(segments.slice(1));
    }

    if (getWorkspaceStatePropertyByAlias(segments[0])) {
      return throwPathError("INVALID_PATH", "Leaf path cannot be listed");
    }

    if (segments[0] === "workspaces") {
      return await this.listWorkspacesPath(segments.slice(1));
    }

    if (segments[0] === "bus") {
      return await this.listBus(segments.slice(1));
    }

    if (segments[0] === "panes") {
      return await this.listPaneStatePath(segments.slice(1), caller);
    }

    if (segments[0] === "status") {
      return await this.listStatusPath(segments.slice(1), caller);
    }

    return notFoundList();
  }

  private async setBySegments(segments: string[], value: unknown, caller: PathCallerContext): Promise<PathSetResult> {
    if (segments.length === 0 || segments[0] === "status" || segments[0] === "bus") {
      return throwPathError("NOT_WRITABLE", "Path is read-only");
    }

    if (segments[0] === "app") {
      const property = segments.length === 2 ? getAppStateProperty(segments[1]) : undefined;
      if (property) {
        const result = await this.setScopedProperty({ scope: "app" }, property, value);
        return {
          ok: true,
          value: result.value
        };
      }

      return throwPathError("NOT_WRITABLE", "Path is not writable");
    }

    const rootProperty = getWorkspaceStatePropertyByAlias(segments[0]);
    if (rootProperty) {
      if (segments.length !== 1) {
        return throwPathError("NOT_WRITABLE", "Path is not writable");
      }

      // Resolve the current workspace from the caller's attachment before
      // dispatching so the write targets the caller's slot (not the default).
      // External callers without an attachment are refused — the explicit
      // /workspaces/{id}/<property> path is the supported alternative.
      const slotKey = requireSlotKey(caller, `/${segments[0]}`, `/workspaces/{id}/${segments[0]}`);
      const workspace = await this.host.getWorkspaceStatus({ slotKey });
      const result = await this.setScopedProperty(
        { scope: "workspace", workspaceId: workspace.id },
        rootProperty,
        value
      );
      return {
        ok: true,
        value: result.value
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

      const property = segments.length === 3 ? getPaneStateProperty(segments[2]) : undefined;
      if (property) {
        const result = await this.setScopedProperty({ scope: "pane", paneId: pane.id }, property, value);
        return {
          ok: true,
          value: result.value
        };
      }

      const subtreeMount = await this.resolvePaneSubtreeMount(pane.id, segments[2]);
      if (subtreeMount) {
        return await this.setPaneMountStatePath(pane.id, subtreeMount, segments.slice(3), value);
      }

      const mount = await this.host.getPanePathMount(pane.id);
      if (mount && segments[2] === mount.mountKey) {
        return await this.setPaneMountStatePath(pane.id, mount, segments.slice(3), value);
      }

      return throwPathError("NOT_WRITABLE", "Path is not writable");
    }

    // Explicit-target workspace property write — the external-caller
    // alternative to the implicit-current /<property> aliases (/title, etc).
    // Preflight the workspace existence so a missing id surfaces as
    // NOT_FOUND rather than INTERNAL_ERROR from shellCore.requireWorkspace.
    // (A delete racing between preflight and setScopedProperty degrades
    // to INTERNAL_ERROR in the narrow window, which is acceptable given
    // how rare concurrent delete-while-set is.)
    if (segments[0] === "workspaces" && segments.length === 3) {
      const workspaceProperty = getWorkspaceStateProperty(segments[2]);
      if (workspaceProperty?.writable) {
        const workspaceId = segments[1]!;
        const workspaces = await this.host.listWorkspaces();
        if (!workspaces.some((candidate) => candidate.id === workspaceId)) {
          return throwPathError("NOT_FOUND", `Workspace '${workspaceId}' not found`);
        }
        const result = await this.setScopedProperty(
          { scope: "workspace", workspaceId },
          workspaceProperty,
          value
        );
        return { ok: true, value: result.value };
      }
    }

    return throwPathError("NOT_WRITABLE", "Path is not writable");
  }

  private async callBySegments(
    segments: string[],
    args: Record<string, unknown>,
    caller: PathCallerContext
  ): Promise<PathCallResult> {
    if (
      segments.length === 0 ||
      segments[0] === "app" ||
      Boolean(getWorkspaceStatePropertyByAlias(segments[0])) ||
      segments[0] === "status"
    ) {
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

    if (segments[0] === "workspaces") {
      // `caller.attachmentId` flows through slot-aware mutations so the
      // attachment-scoped events (workspace.activeChanged) target the right
      // slot. Mutations without caller.attachmentId land on the authority's
      // default slot.
      const slotKey = caller.attachmentId;
      const slotOptions = slotKey ? { slotKey } : undefined;

      if (segments.length === 2 && segments[1] === "new") {
        const createdWorkspace = await this.host.createWorkspace(
          { title: optionalString(args.title) },
          slotOptions
        );
        return {
          ok: true,
          value: {
            workspaceId: createdWorkspace.id,
            path: `/workspaces/${createdWorkspace.id}`,
            workspace: createdWorkspace
          }
        };
      }

      if (segments.length === 3 && segments[2] === "reset") {
        const resetWorkspace = await this.host.resetWorkspace(segments[1]);
        return {
          ok: true,
          value: {
            workspaceId: resetWorkspace.id,
            workspace: resetWorkspace
          }
        };
      }

      if (segments.length === 3 && segments[2] === "setActive") {
        await this.host.setActiveWorkspace(segments[1]!, slotOptions);
        return { ok: true, value: { workspaceId: segments[1] } };
      }

      if (segments.length === 3 && segments[2] === "delete") {
        await this.host.deleteWorkspace(segments[1]!);
        return { ok: true, value: { workspaceId: segments[1], deleted: true } };
      }

      return throwPathError("NOT_CALLABLE", "Path is not callable");
    }

    if (segments[0] !== "panes") {
      return throwPathError("NOT_CALLABLE", "Path is not callable");
    }

    if (segments.length === 2 && segments[1] === "new") {
      const { input, workspaceId: argsWorkspaceId } = parseNewPaneArgs(args);
      if (!(await this.host.hasPaneKind(input.kind))) {
        return throwPathError("INVALID_VALUE", `Unsupported pane kind '${input.kind}'`);
      }

      // Resolution order: args.workspaceId > caller.workspaceId > slot's active (via host fallback).
      // Host throws INVALID_VALUE when all three are absent.
      const workspaceId = argsWorkspaceId ?? caller.workspaceId;
      const slotKey = caller.attachmentId;
      const pane = await this.host.createPane(
        input,
        workspaceId || slotKey ? { workspaceId, slotKey } : undefined
      );
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

      if (segments.length === 4 && segments[3] === "attach") {
        // attach is idempotent: the delegate returns the existing runtime
        // snapshot when one is already attached, so browser reloads and
        // multi-device subscribers share the same ptyd session instead of
        // getting rejected.
        const result = await this.terminal.attachRuntime(pane.id, {
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

    if (segments.length === 3 && segments[2] === "setActive") {
      await this.host.setActivePane(pane.id, caller.attachmentId ? { slotKey: caller.attachmentId } : undefined);
      return { ok: true, value: { paneId: pane.id } };
    }

    if (segments.length === 3 && segments[2] === "params:patch") {
      const patched = await this.host.patchPaneParams(pane.id, args);
      return {
        ok: true,
        value: patched
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
        value: statePropertySnapshot(appStatus, APP_STATE_PROPERTIES)
      };
    }

    const property = segments.length === 1 ? getAppStateProperty(segments[0]) : undefined;
    if (property) {
      return {
        ok: true,
        found: true,
        value: property.read(appStatus)
      };
    }

    return notFoundGet();
  }

  private async getWorkspaces(segments: string[]): Promise<PathGetResult> {
    const workspaces = await this.host.listWorkspaces();

    if (segments.length === 0) {
      return {
        ok: true,
        found: true,
        value: Object.fromEntries(
          workspaces.map((workspace) => [workspace.id, workspace])
        )
      };
    }

    const workspace = workspaces.find((candidate) => candidate.id === segments[0]);
    if (!workspace) {
      return notFoundGet();
    }

    if (segments.length === 1) {
      return {
        ok: true,
        found: true,
        value: workspace
      };
    }

    const property = segments.length === 2 ? getWorkspaceStateProperty(segments[1]) : undefined;
    if (property) {
      return {
        ok: true,
        found: true,
        value: property.read(workspace)
      };
    }

    if (segments.length === 2 && isWorkspaceStatusKey(segments[1])) {
      return {
        ok: true,
        found: true,
        value: workspace[segments[1]]
      };
    }

    return notFoundGet();
  }

  private async listApp(segments: string[]): Promise<PathListResult> {
    if (segments.length === 0) {
      return {
        ok: true,
        found: true,
        entries: statePropertyEntries(APP_STATE_PROPERTIES, "/app")
      };
    }

    if (segments.length === 1 && getAppStateProperty(segments[0])) {
      return throwPathError("INVALID_PATH", "Leaf path cannot be listed");
    }

    return notFoundList();
  }

  private async listWorkspacesPath(segments: string[]): Promise<PathListResult> {
    const workspaces = await this.host.listWorkspaces();

    if (segments.length === 0) {
      return {
        ok: true,
        found: true,
        entries: [
          ...workspaces.map((workspace) => objectEntry(workspace.id, `/workspaces/${workspace.id}`)),
          actionEntry("new", "/workspaces/new")
        ]
      };
    }

    if (segments.length === 1 && segments[0] === "new") {
      return throwPathError("INVALID_PATH", "Action path cannot be listed");
    }

    const workspace = workspaces.find((candidate) => candidate.id === segments[0]);
    if (!workspace) {
      return notFoundList();
    }

    if (segments.length === 1) {
      return {
        ok: true,
        found: true,
        entries: [
          leafEntry("id", `/workspaces/${workspace.id}/id`),
          ...statePropertyEntries(WORKSPACE_STATE_PROPERTIES, `/workspaces/${workspace.id}`, "key"),
          leafEntry("paneCount", `/workspaces/${workspace.id}/paneCount`)
        ]
      };
    }

    if (segments.length === 2 && (getWorkspaceStateProperty(segments[1]) || isWorkspaceStatusKey(segments[1]))) {
      return throwPathError("INVALID_PATH", "Leaf path cannot be listed");
    }

    return notFoundList();
  }

  private async getPaneStatePath(segments: string[], caller: PathCallerContext): Promise<PathGetResult> {
    if (segments.length === 0) {
      const slotKey = requireSlotKey(caller, "/panes", "/status/workspaces/{id}/panes");
      const panes = await this.host.listPanes({ slotKey });
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

    const property = segments.length === 2 ? getPaneStateProperty(segments[1]) : undefined;
    if (property) {
      return {
        ok: true,
        found: true,
        value: property.read(pane)
      };
    }

    if (segments.length === 3 && segments[1] === "terminal" && pane.kind === "terminal" && isTerminalActionSegment(segments[2])) {
      return throwPathError("INVALID_PATH", "Action path cannot be read");
    }

    const subtreeMount = await this.resolvePaneSubtreeMount(pane.id, segments[1]);
    if (subtreeMount) {
      return await this.getPaneMountPath(subtreeMount, segments.slice(2), "state");
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

  private async listPaneStatePath(segments: string[], caller: PathCallerContext): Promise<PathListResult> {
    if (segments.length === 0) {
      const slotKey = requireSlotKey(caller, "/panes", "/status/workspaces/{id}/panes");
      const panes = await this.host.listPanes({ slotKey });
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
      const subtreeMounts = await this.host.getPaneSubtreeMounts(pane.id);
      return {
        ok: true,
        found: true,
        entries: withMountEntries(paneStateEntries(pane, `/panes/${segments[0]}`), [...subtreeMounts, ...(mount ? [mount] : [])], `/panes/${segments[0]}`)
      };
    }

    if (segments.length === 2) {
      if (segments[1] === "kind" || getPaneStateProperty(segments[1])) {
        return throwPathError("INVALID_PATH", "Leaf path cannot be listed");
      }

      if (pane.kind === "terminal" && segments[1] === "terminal") {
        const subtreeMount = await this.resolvePaneSubtreeMount(pane.id, segments[1]);
        if (!subtreeMount) {
          return notFoundList();
        }

        const listed = await this.listPaneMountPath(subtreeMount, [], `/panes/${segments[0]}/${subtreeMount.mountKey}`, "state");
        if (!listed.ok || !listed.found) {
          return listed;
        }

        return {
          ok: true,
          found: true,
          entries: [
            ...listed.entries,
            ...terminalActionEntries(`/panes/${segments[0]}/terminal`)
          ]
        };
      }

      const subtreeMount = await this.resolvePaneSubtreeMount(pane.id, segments[1]);
      if (subtreeMount) {
        return await this.listPaneMountPath(subtreeMount, [], `/panes/${segments[0]}/${subtreeMount.mountKey}`, "state");
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

  private async getStatusPath(segments: string[], caller: PathCallerContext): Promise<PathGetResult> {
    if (segments.length === 0) {
      // `panes` here is slot-scoped (current workspace's panes); external
      // callers without an attachment get the aggregate subtrees only
      // (`app`, `attachments`, `workspaces`) and must compose their view
      // via `/status/workspaces/{id}/panes` for pane details.
      const slotKey = caller.attachmentId;
      const [app, attachments, workspaces, panes] = await Promise.all([
        this.host.getAppStatus(),
        this.host.listAttachmentSlots(),
        this.host.listWorkspaces(),
        slotKey ? this.host.listPanes({ slotKey }) : []
      ]);
      return {
        ok: true,
        found: true,
        value: {
          app,
          attachments: Object.fromEntries(attachments.map((entry) => [entry.attachmentId, entry])),
          workspaces: Object.fromEntries(workspaces.map((workspace) => [workspace.id, workspace])),
          ...(slotKey ? {
            panes: Object.fromEntries(
              panes.map((pane) => [pane.id, toPaneStatusSnapshot(pane)])
            )
          } : {})
        }
      };
    }

    if (segments[0] === "app") {
      return await this.getStatusApp(segments.slice(1));
    }

    if (segments[0] === "attachments") {
      return await this.getStatusAttachments(segments.slice(1));
    }

    if (segments[0] === "workspace") {
      return await this.getStatusWorkspace(segments.slice(1), caller);
    }

    if (segments[0] === "workspaces") {
      return await this.getStatusWorkspaces(segments.slice(1));
    }

    if (segments[0] === "panes") {
      return await this.getStatusPanes(segments.slice(1), caller);
    }

    return notFoundGet();
  }

  private async listStatusPath(segments: string[], caller: PathCallerContext): Promise<PathListResult> {
    if (segments.length === 0) {
      return {
        ok: true,
        found: true,
        entries: [
          objectEntry("app", "/status/app"),
          objectEntry("attachments", "/status/attachments"),
          objectEntry("workspace", "/status/workspace"),
          objectEntry("workspaces", "/status/workspaces"),
          objectEntry("panes", "/status/panes")
        ]
      };
    }

    if (segments[0] === "app") {
      return await this.listStatusApp(segments.slice(1));
    }

    if (segments[0] === "attachments") {
      return await this.listStatusAttachments(segments.slice(1));
    }

    if (segments[0] === "workspace") {
      return await this.listStatusWorkspace(segments.slice(1), caller);
    }

    if (segments[0] === "workspaces") {
      return await this.listStatusWorkspaces(segments.slice(1));
    }

    if (segments[0] === "panes") {
      return await this.listStatusPanes(segments.slice(1), caller);
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

  private async getStatusWorkspace(segments: string[], caller: PathCallerContext): Promise<PathGetResult> {
    const slotKey = requireSlotKey(
      caller,
      "/status/workspace",
      "/status/attachments/{attachmentId}/currentWorkspace or /status/workspaces/{id}"
    );
    const workspaceStatus = await this.host.getWorkspaceStatus({ slotKey });

    if (segments.length === 0) {
      return { ok: true, found: true, value: workspaceStatus };
    }

    if (segments.length === 1 && isWorkspaceStatusKey(segments[0])) {
      return { ok: true, found: true, value: workspaceStatus[segments[0]] };
    }

    return notFoundGet();
  }

  private async listStatusWorkspace(segments: string[], caller: PathCallerContext): Promise<PathListResult> {
    requireSlotKey(
      caller,
      "/status/workspace",
      "/status/attachments/{attachmentId}/currentWorkspace or /status/workspaces/{id}"
    );
    if (segments.length === 0) {
      return {
        ok: true,
        found: true,
        entries: [
          leafEntry("id", "/status/workspace/id"),
          leafEntry("title", "/status/workspace/title"),
          leafEntry("paneCount", "/status/workspace/paneCount")
        ]
      };
    }

    if (segments.length === 1 && isWorkspaceStatusKey(segments[0])) {
      return throwPathError("INVALID_PATH", "Leaf path cannot be listed");
    }

    return notFoundList();
  }

  private async getStatusAttachments(segments: string[]): Promise<PathGetResult> {
    const attachments = await this.host.listAttachmentSlots();
    if (segments.length === 0) {
      return {
        ok: true,
        found: true,
        value: Object.fromEntries(attachments.map((entry) => [entry.attachmentId, entry]))
      };
    }

    const attachment = attachments.find((entry) => entry.attachmentId === segments[0]);
    if (!attachment) {
      return notFoundGet();
    }

    if (segments.length === 1) {
      return { ok: true, found: true, value: attachment };
    }

    if (segments.length === 2) {
      if (segments[1] === "attachmentId") {
        return { ok: true, found: true, value: attachment.attachmentId };
      }
      if (segments[1] === "activeWorkspaceId") {
        return { ok: true, found: true, value: attachment.activeWorkspaceId };
      }
      if (segments[1] === "activePaneIdByWorkspace") {
        return { ok: true, found: true, value: attachment.activePaneIdByWorkspace };
      }
    }

    if (segments[1] === "currentWorkspace") {
      if (!attachment.activeWorkspaceId) {
        return { ok: true, found: false, value: null };
      }
      // Delegate the workspace subtree to getStatusWorkspaces so the aliasing
      // layer (paneCount/title/panes/*) stays in one place.
      return await this.getStatusWorkspaces([attachment.activeWorkspaceId, ...segments.slice(2)]);
    }

    return notFoundGet();
  }

  private async listStatusAttachments(segments: string[]): Promise<PathListResult> {
    const attachments = await this.host.listAttachmentSlots();
    if (segments.length === 0) {
      return {
        ok: true,
        found: true,
        entries: attachments.map((entry) => objectEntry(entry.attachmentId, `/status/attachments/${entry.attachmentId}`))
      };
    }

    const attachment = attachments.find((entry) => entry.attachmentId === segments[0]);
    if (!attachment) {
      return notFoundList();
    }

    if (segments.length === 1) {
      return {
        ok: true,
        found: true,
        entries: [
          leafEntry("attachmentId", `/status/attachments/${attachment.attachmentId}/attachmentId`),
          leafEntry("activeWorkspaceId", `/status/attachments/${attachment.attachmentId}/activeWorkspaceId`),
          leafEntry("activePaneIdByWorkspace", `/status/attachments/${attachment.attachmentId}/activePaneIdByWorkspace`),
          objectEntry("currentWorkspace", `/status/attachments/${attachment.attachmentId}/currentWorkspace`)
        ]
      };
    }

    if (segments.length === 2) {
      if (
        segments[1] === "attachmentId" ||
        segments[1] === "activeWorkspaceId" ||
        segments[1] === "activePaneIdByWorkspace"
      ) {
        return throwPathError("INVALID_PATH", "Leaf path cannot be listed");
      }
      if (segments[1] === "currentWorkspace" && attachment.activeWorkspaceId) {
        return {
          ok: true,
          found: true,
          entries: [
            leafEntry("id", `/status/attachments/${attachment.attachmentId}/currentWorkspace/id`),
            leafEntry("title", `/status/attachments/${attachment.attachmentId}/currentWorkspace/title`),
            leafEntry("paneCount", `/status/attachments/${attachment.attachmentId}/currentWorkspace/paneCount`)
          ]
        };
      }
    }

    return notFoundList();
  }

  private async getStatusWorkspaces(segments: string[]): Promise<PathGetResult> {
    if (segments.length === 0) {
      const workspaces = await this.host.listWorkspaces();
      return {
        ok: true,
        found: true,
        value: Object.fromEntries(workspaces.map((workspace) => [workspace.id, workspace]))
      };
    }

    const workspaceId = segments[0];
    const workspaces = await this.host.listWorkspaces();
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) {
      return notFoundGet();
    }

    if (segments.length === 1) {
      return { ok: true, found: true, value: workspace };
    }

    if (segments.length === 2) {
      if (segments[1] === "panes") {
        const panes = await this.host.listPanesByWorkspace(workspaceId);
        return {
          ok: true,
          found: true,
          value: Object.fromEntries(panes.map((pane) => [pane.id, toPaneStatusSnapshot(pane)]))
        };
      }
      if (isWorkspaceStatusKey(segments[1])) {
        return { ok: true, found: true, value: workspace[segments[1]] };
      }
    }

    return notFoundGet();
  }

  private async listStatusWorkspaces(segments: string[]): Promise<PathListResult> {
    const workspaces = await this.host.listWorkspaces();
    if (segments.length === 0) {
      return {
        ok: true,
        found: true,
        entries: workspaces.map((workspace) => objectEntry(workspace.id, `/status/workspaces/${workspace.id}`))
      };
    }

    const workspaceId = segments[0];
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) {
      return notFoundList();
    }

    if (segments.length === 1) {
      return {
        ok: true,
        found: true,
        entries: [
          leafEntry("id", `/status/workspaces/${workspaceId}/id`),
          leafEntry("title", `/status/workspaces/${workspaceId}/title`),
          leafEntry("paneCount", `/status/workspaces/${workspaceId}/paneCount`),
          objectEntry("panes", `/status/workspaces/${workspaceId}/panes`)
        ]
      };
    }

    if (segments.length === 2) {
      if (isWorkspaceStatusKey(segments[1])) {
        return throwPathError("INVALID_PATH", "Leaf path cannot be listed");
      }
      if (segments[1] === "panes") {
        const panes = await this.host.listPanesByWorkspace(workspaceId);
        return {
          ok: true,
          found: true,
          entries: panes.map((pane) => objectEntry(pane.id, `/status/workspaces/${workspaceId}/panes/${pane.id}`))
        };
      }
    }

    return notFoundList();
  }

  private async getStatusPanes(segments: string[], caller: PathCallerContext): Promise<PathGetResult> {
    if (segments.length === 0) {
      const slotKey = requireSlotKey(caller, "/status/panes", "/status/workspaces/{id}/panes");
      const panes = await this.host.listPanes({ slotKey });
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

    if (segments.length === 2 && isPaneStatusLeaf(segments[1])) {
      return { ok: true, found: true, value: status[segments[1]] };
    }

    const subtreeMount = await this.resolvePaneSubtreeMount(pane.id, segments[1]);
    if (subtreeMount) {
      return await this.getPaneMountPath(subtreeMount, segments.slice(2), "status");
    }

    const mount = await this.host.getPanePathMount(pane.id);
    if (mount && segments[1] === mount.mountKey) {
      return await this.getPaneMountPath(mount, segments.slice(2), "status");
    }

    return notFoundGet();
  }

  private async listStatusPanes(segments: string[], caller: PathCallerContext): Promise<PathListResult> {
    if (segments.length === 0) {
      const slotKey = requireSlotKey(caller, "/status/panes", "/status/workspaces/{id}/panes");
      const panes = await this.host.listPanes({ slotKey });
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
      const subtreeMounts = await this.host.getPaneSubtreeMounts(pane.id);
      return {
        ok: true,
        found: true,
        entries: withMountEntries(
          paneStatusEntries(pane, `/status/panes/${segments[0]}`),
          [...subtreeMounts, ...(mount ? [mount] : [])],
          `/status/panes/${segments[0]}`
        )
      };
    }

    if (segments.length === 2) {
      const subtreeMount = await this.resolvePaneSubtreeMount(pane.id, segments[1]);
      if (subtreeMount) {
        return await this.listPaneMountPath(
          subtreeMount,
          [],
          `/status/panes/${segments[0]}/${subtreeMount.mountKey}`,
          "status"
        );
      }
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

  private async getWorkspaceRootSnapshot(caller: PathCallerContext) {
    // The root snapshot mixes implicit-current workspace/pane fields with
    // aggregates. If caller has no attachment, omit those fields — external
    // callers compose explicit subtrees (/status/workspaces/{id}, etc.)
    // instead of receiving a half-populated default-slot snapshot.
    const slotKey = caller.attachmentId;
    const [workspace, workspaces, panes, app] = await Promise.all([
      slotKey ? this.host.getWorkspaceStatus({ slotKey }) : null,
      this.host.listWorkspaces(),
      slotKey ? this.host.listPanes({ slotKey }) : [],
      this.host.getAppStatus()
    ]);
    return {
      ...(workspace ? statePropertySnapshot(workspace, WORKSPACE_STATE_PROPERTIES, "alias") : {}),
      workspaces: Object.fromEntries(
        workspaces.map((entry) => [entry.id, entry])
      ),
      bus: {},
      panes: Object.fromEntries(
        panes.map((pane) => [pane.id, toPaneStateSnapshot(pane)])
      ),
      status: {
        app,
        ...(workspace ? { workspace } : {}),
        panes: Object.fromEntries(
          panes.map((pane) => [pane.id, toPaneStatusSnapshot(pane)])
        )
      }
    };
  }

  private async resolvePane(paneSegment: string): Promise<ShellPaneRecordSnapshot | undefined> {
    if (paneSegment === "current") {
      const activePaneId = await this.host.getCurrentPaneId();
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

  private async resolvePaneSubtreeMount(paneId: string, mountKey: string) {
    return (await this.host.getPaneSubtreeMounts(paneId)).find((mount) => mount.mountKey === mountKey);
  }

  private async setScopedProperty(
    target: ScopedPropertyTarget,
    property: ScopedStatePropertyDescriptor<any>,
    value: unknown
  ) {
    return await this.host.setScopedProperty(target, property.key, asNonEmptyString(value, property.label));
  }
}

interface ScopedStatePropertyDescriptor<TTarget> {
  key: string;
  label: string;
  writable: boolean;
  alias?: string;
  read(target: TTarget): unknown;
}

const APP_STATE_PROPERTIES: readonly ScopedStatePropertyDescriptor<AppStatusSnapshot>[] = [
  {
    key: "title",
    label: "App title",
    writable: true,
    read: (app) => app.title
  }
];

const WORKSPACE_STATE_PROPERTIES: readonly ScopedStatePropertyDescriptor<Awaited<ReturnType<ShellModelHost["getWorkspaceStatus"]>>>[] = [
  {
    key: "title",
    label: "Workspace title",
    writable: true,
    alias: "title",
    read: (workspace) => workspace.title
  }
];

const PANE_STATE_PROPERTIES: readonly ScopedStatePropertyDescriptor<ShellPaneRecordSnapshot>[] = [
  {
    key: "title",
    label: "Pane title",
    writable: true,
    read: (pane) => pane.title
  }
];

function getAppStateProperty(key: string) {
  return APP_STATE_PROPERTIES.find((property) => property.key === key);
}

function getWorkspaceStateProperty(key: string) {
  return WORKSPACE_STATE_PROPERTIES.find((property) => property.key === key);
}

function getWorkspaceStatePropertyByAlias(alias: string) {
  return WORKSPACE_STATE_PROPERTIES.find((property) => (property.alias ?? property.key) === alias);
}

function getPaneStateProperty(key: string) {
  return PANE_STATE_PROPERTIES.find((property) => property.key === key);
}

function statePropertyEntries(
  properties: readonly ScopedStatePropertyDescriptor<any>[],
  basePath: string,
  pathMode: "key" | "alias" = "key",
  writableOverride?: boolean
) {
  return properties.map((property) => {
    const leafName = pathMode === "alias" ? property.alias ?? property.key : property.key;
    return leafEntry(
      leafName,
      `${basePath}/${leafName}`.replace(/\/+/g, "/"),
      writableOverride ?? property.writable
    );
  });
}

function statePropertySnapshot(
  target: AppStatusSnapshot | Awaited<ReturnType<ShellModelHost["getWorkspaceStatus"]>>,
  properties: readonly ScopedStatePropertyDescriptor<any>[],
  keyMode: "key" | "alias" = "key"
) {
  return Object.fromEntries(
    properties.map((property) => [keyMode === "alias" ? property.alias ?? property.key : property.key, property.read(target)])
  );
}

function workspaceRootAliasEntries() {
  return statePropertyEntries(WORKSPACE_STATE_PROPERTIES, "", "alias");
}

export class ModelPathError extends Error {
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

function parseNewPaneArgs(args: Record<string, unknown>): { input: NewPaneInput; workspaceId: string | undefined } {
  const kind = optionalString(args.kind);
  if (!kind) {
    throw new ModelPathError("INVALID_VALUE", "call /panes/new requires kind=...");
  }

  const place = normalizePlacement(args.place);
  const title = optionalString(args.title);
  const url = optionalString(args.url);
  const cwd = optionalString(args.cwd);
  const referencePaneId = optionalString(args.referencePaneId);
  const workspaceId = optionalString(args.workspaceId);
  const params = Object.fromEntries(
    Object.entries(args).filter(([key]) => (
      key !== "kind" &&
      key !== "title" &&
      key !== "url" &&
      key !== "cwd" &&
      key !== "place" &&
      key !== "referencePaneId" &&
      key !== "workspaceId"
    ))
  );

  return {
    input: {
      kind,
      title,
      url,
      cwd,
      params: Object.keys(params).length > 0 ? params : undefined,
      place,
      referencePaneId
    },
    workspaceId
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
        browser: toBrowserStatusSnapshot(pane)
      }
    : pane.kind === "terminal"
      ? {
          id: pane.id,
          kind: pane.kind,
          title: pane.title,
          terminal: toTerminalStatusSnapshot(pane)
        }
    : { id: pane.id, kind: pane.kind, title: pane.title };
}

function paneStateEntries(_pane: ShellPaneRecordSnapshot, basePath: string): ShellPathEntry[] {
  const propertyEntries = statePropertyEntries(PANE_STATE_PROPERTIES, basePath);
  return [
    leafEntry("kind", `${basePath}/kind`),
    ...propertyEntries,
    actionEntry("close", `${basePath}/close`)
  ];
}

function paneStatusEntries(_pane: ShellPaneRecordSnapshot, basePath: string): ShellPathEntry[] {
  const propertyEntries = statePropertyEntries(PANE_STATE_PROPERTIES, basePath, "key", false);
  return [
    leafEntry("id", `${basePath}/id`),
    leafEntry("kind", `${basePath}/kind`),
    ...propertyEntries
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
  return value === "id" || value === "title" || value === "paneCount";
}

function isPaneStatusKey(value: string): value is keyof ReturnType<typeof toPaneStatusSnapshot> {
  return value === "id" || value === "kind" || value === "title";
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

function isTerminalActionSegment(segment: string) {
  return segment === "attach" || segment === "write" || segment === "resize" || segment === "history" || segment === "kill";
}

function terminalActionEntries(basePath: string) {
  return [
    actionEntry("attach", `${basePath}/attach`),
    actionEntry("write", `${basePath}/write`),
    actionEntry("resize", `${basePath}/resize`),
    actionEntry("history", `${basePath}/history`),
    actionEntry("kill", `${basePath}/kill`)
  ];
}

function withMountEntries(
  entries: ShellPathEntry[],
  mounts: Array<ShellResolvedPaneSubtreeMount>,
  basePath: string
) {
  return mounts.length > 0
    ? [
        ...entries,
        ...mounts.map((mount) => objectEntry(mount.mountKey, `${basePath}/${mount.mountKey}`))
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

/**
 * Implicit-current guard: paths like /status/workspace or /title only make
 * sense for a caller with attachment context (preload/WS clients). External
 * HTTP/CLI callers get INVALID_VALUE with a pointer at the explicit-target
 * equivalent so they don't depend on transport-dependent semantics.
 */
function requireSlotKey(caller: PathCallerContext, attemptedPath: string, suggested: string): string {
  if (!caller.attachmentId) {
    throw new ModelPathError(
      "INVALID_VALUE",
      `${attemptedPath} requires attachment context; use ${suggested}`
    );
  }
  return caller.attachmentId;
}
