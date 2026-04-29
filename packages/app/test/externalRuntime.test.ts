import { describe, expect, it } from "bun:test";
import type { ExtensionPaneContext } from "@flmux/extension-api";
import { createExternalPaneDescriptor } from "../src/renderer/external/runtime";
import { PaneRegistry, type PaneRendererRuntimeContext } from "../src/renderer/shell/paneRegistry";
import { createWorkspaceStatusStore } from "@flmux/core/shell";
import type { PathCallerContext, ShellModelAPI, WorkspaceBus, WorkspaceBusEvent } from "@flmux/core/shell/types";
import { makePaneWorkspaceContext } from "./support/paneWorkspaceContext";

const EXTERNAL_ID = "workspace.external";

describe("external pane runtime", () => {
  it("adapts shell paths and bus publish with pane-scoped caller context", async () => {
    const shellCalls = {
      get: [] as string[],
      list: [] as string[],
      set: [] as Array<{ path: string; value: unknown }>,
      call: [] as Array<{ path: string; args?: Record<string, unknown>; caller?: PathCallerContext }>
    };
    const subscriptions: string[] = [];
    const busPublished: WorkspaceBusEvent[] = [];
    let capturedContext!: ExtensionPaneContext;
    let didCaptureContext = false;

    const shellModel: ShellModelAPI = {
      pathGet: async (path) => {
        shellCalls.get.push(path);
        return { ok: true, found: true, value: path };
      },
      pathList: async (path) => {
        shellCalls.list.push(path);
        return { ok: true, found: true, entries: [] };
      },
      pathSet: async (path, value) => {
        shellCalls.set.push({ path, value });
        return { ok: true, value };
      },
      pathCall: async (path, args, caller) => {
        shellCalls.call.push({ path, args, caller });
        return { ok: true, value: { path, args, caller } };
      }
    };

    const workspaceBus: WorkspaceBus = {
      publish<T>(event: WorkspaceBusEvent<T>) {
        busPublished.push(event as WorkspaceBusEvent);
      },
      subscribe<T>(topic: string, _handler: (event: WorkspaceBusEvent<T>) => void) {
        subscriptions.push(topic);
        return () => {};
      }
    };

    const descriptor = createExternalPaneDescriptor({
      kind: "sample.external",
      mount(_host, context) {
        capturedContext = context;
        didCaptureContext = true;
      }
    });

    const renderer = descriptor.createRenderer({
      workspace: makePaneWorkspaceContext({ id: EXTERNAL_ID, bus: workspaceBus }),
      options: {
        id: "pane.external",
        name: "sample.external"
      },
      runtime: {
        shellModel,
        browserPanelTemplate: null as never,
        terminalHost: null as never,
        workspaceStatus: createWorkspaceStatusStore(),
        normalizeBrowserUrl: () => null,
        onBrowserUrlChange() {}
      } satisfies PaneRendererRuntimeContext
    });
    renderer.init?.({
      api: {
        id: "pane.external",
        title: "External",
        updateParameters() {},
        setTitle() {}
      } as never,
      containerApi: null as never,
      title: "External",
      params: {}
    });

    if (!didCaptureContext) {
      throw new Error("external pane context was not captured");
    }

    expect(capturedContext.paneId).toBe("pane.external");
    expect(capturedContext.workspaceId).toBe("workspace.external");

    await capturedContext.shell.get("/title");
    await capturedContext.shell.list("/panes");
    await capturedContext.shell.set("/title", "moo");
    await capturedContext.shell.call("/panes/new", { kind: "cowsay" });
    await capturedContext.bus.publish("cowsay.message", { text: "moo" });
    capturedContext.bus.subscribe("cowsay.*", () => {});

    expect(shellCalls.get).toEqual(["/title"]);
    expect(shellCalls.list).toEqual(["/panes"]);
    expect(shellCalls.set).toEqual([{ path: "/title", value: "moo" }]);
    expect(shellCalls.call).toEqual([
      {
        path: "/panes/new",
        args: { kind: "cowsay" },
        caller: { sourcePaneId: "pane.external" }
      }
    ]);
    expect(busPublished).toEqual([
      expect.objectContaining({
        topic: "cowsay.message",
        sourcePaneId: "pane.external",
        payload: { text: "moo" },
        workspaceId: "workspace.external"
      })
    ]);
    expect(subscriptions).toEqual(["cowsay.*"]);
  });

  it("maps a minimal external getTitle hook onto the internal descriptor lifecycle", () => {
    const descriptor = createExternalPaneDescriptor({
      kind: "sample.titled",
      mount() {},
      getTitle: ({ input, workspaceId }) => `${workspaceId}:${input.title ?? "Untitled"}`
    });

    expect(
      descriptor.lifecycle?.getTitle?.({
        workspace: makePaneWorkspaceContext({ id: EXTERNAL_ID }),
        input: {
          kind: "sample.titled",
          title: "Probe"
        },
        params: undefined
      })
    ).toBe("workspace.external:Probe");
  });

  it("maps external params hooks and state updates onto the internal renderer contract", async () => {
    let capturedContext!: ExtensionPaneContext;
    let updatedParameters: Record<string, unknown> | undefined;
    let updatedTitle: string | undefined;
    const pathSetCalls: Array<{ path: string; value: unknown }> = [];
    const pathCallCalls: Array<{ path: string; args: Record<string, unknown> | undefined }> = [];

    const descriptor = createExternalPaneDescriptor({
      kind: "sample.stateful",
      mount(_host, context) {
        capturedContext = context;
      },
      createParams: ({ input }) => ({
        note: input.params?.note ?? ""
      }),
      getTitle: ({ input }) => input.title?.trim() || "Stateful",
      normalizeRestoredParams: ({ params }) => ({
        note: typeof params?.note === "string" ? params.note : ""
      }),
      serializeParams: ({ currentParams }) => ({
        note: typeof currentParams?.note === "string" ? currentParams.note : ""
      })
    });

    const renderer = descriptor.createRenderer({
      workspace: makePaneWorkspaceContext({ id: EXTERNAL_ID }),
      options: {
        id: "pane.stateful",
        name: "sample.stateful"
      },
      runtime: {
        shellModel: {
          pathGet: async () => ({ ok: true, found: true, value: null }),
          pathList: async () => ({ ok: true, found: true, entries: [] }),
          pathSet: async (path, value) => {
            pathSetCalls.push({ path, value });
            return { ok: true, value };
          },
          pathCall: async (path, args) => {
            pathCallCalls.push({ path, args });
            return { ok: true, value: null };
          }
        },
        browserPanelTemplate: null as never,
        terminalHost: null as never,
        workspaceStatus: createWorkspaceStatusStore(),
        normalizeBrowserUrl: () => null,
        onBrowserUrlChange() {}
      }
    });

    renderer.init?.({
      api: {
        id: "pane.stateful",
        title: "Stateful",
        updateParameters(parameters: Record<string, unknown>) {
          updatedParameters = parameters;
        },
        setTitle(title: string) {
          updatedTitle = title;
        }
      } as never,
      containerApi: null as never,
      title: "Stateful",
      params: {
        note: "seed",
        stale: true
      }
    });

    expect(capturedContext.state.getParams<{ note: string; stale: boolean }>()).toEqual({
      note: "seed",
      stale: true
    });

    capturedContext.state.patchParams({
      note: "patched"
    });
    expect(updatedParameters).toEqual({
      note: "patched",
      stale: true
    });
    await Promise.resolve();
    expect(pathCallCalls).toContainEqual({
      path: "/panes/pane.stateful/params:patch",
      args: { note: "patched" }
    });

    renderer.update?.({
      params: {
        note: "restored"
      }
    });
    expect(capturedContext.state.getParams<{ note: string }>()).toEqual({
      note: "restored"
    });

    capturedContext.state.setTitle("Updated Title");
    await Promise.resolve();
    expect(pathSetCalls).toContainEqual({ path: "/panes/pane.stateful/title", value: "Updated Title" });
    expect(updatedTitle).toBeUndefined();

    expect(
      descriptor.lifecycle?.createParams?.({
        workspace: makePaneWorkspaceContext({ id: EXTERNAL_ID }),
        input: {
          kind: "sample.stateful",
          params: {
            note: "created"
          }
        }
      })
    ).toEqual({
      note: "created"
    });

    expect(
      descriptor.persistence?.normalizeRestoredParams?.({
        workspace: makePaneWorkspaceContext({ id: EXTERNAL_ID }),
        params: {
          note: 123
        } as never
      })
    ).toEqual({
      note: ""
    });

    expect(
      descriptor.persistence?.serializeParams?.({
        workspace: makePaneWorkspaceContext({ id: EXTERNAL_ID }),
        record: {
          kind: "sample.stateful"
        },
        currentParams: {
          note: "saved"
        }
      })
    ).toEqual({
      note: "saved"
    });
  });

  it("cleans up tracked bus subscriptions when an external pane is disposed", () => {
    let unsubscribeCalls = 0;
    let rendererDisposed = false;

    const descriptor = createExternalPaneDescriptor({
      kind: "sample.bus-cleanup",
      mount(_host, context) {
        context.bus.subscribe("sample.*", () => {});
        return {
          dispose() {
            rendererDisposed = true;
          }
        };
      }
    });

    const renderer = descriptor.createRenderer({
      workspace: makePaneWorkspaceContext({
        id: EXTERNAL_ID,
        bus: {
          publish() {},
          subscribe() {
            return () => {
              unsubscribeCalls += 1;
            };
          }
        }
      }),
      options: {
        id: "pane.cleanup",
        name: "sample.bus-cleanup"
      },
      runtime: {
        shellModel: {
          pathGet: async () => ({ ok: true, found: true, value: null }),
          pathList: async () => ({ ok: true, found: true, entries: [] }),
          pathSet: async (_path, value) => ({ ok: true, value }),
          pathCall: async () => ({ ok: true, value: null })
        },
        browserPanelTemplate: null as never,
        terminalHost: null as never,
        workspaceStatus: createWorkspaceStatusStore(),
        normalizeBrowserUrl: () => null,
        onBrowserUrlChange() {}
      }
    });
    renderer.init?.({
      api: {
        id: "pane.cleanup",
        title: "Cleanup",
        updateParameters() {},
        setTitle() {}
      } as never,
      containerApi: null as never,
      title: "Cleanup",
      params: {}
    });

    renderer.dispose?.();
    expect(rendererDisposed).toBe(true);
    expect(unsubscribeCalls).toBe(1);
  });

  it("cleans up workspaceStatus subscriptions when an external pane is disposed", () => {
    const sharedStatus = createWorkspaceStatusStore();
    let received = 0;

    const descriptor = createExternalPaneDescriptor({
      kind: "sample.status-cleanup",
      mount(_host, context) {
        context.workspaceStatus.subscribe("k", () => {
          received += 1;
        });
      }
    });

    const renderer = descriptor.createRenderer({
      workspace: makePaneWorkspaceContext({ id: EXTERNAL_ID }),
      options: { id: "pane.status-cleanup", name: "sample.status-cleanup" },
      runtime: {
        shellModel: {
          pathGet: async () => ({ ok: true, found: true, value: null }),
          pathList: async () => ({ ok: true, found: true, entries: [] }),
          pathSet: async (_path, value) => ({ ok: true, value }),
          pathCall: async () => ({ ok: true, value: null })
        },
        browserPanelTemplate: null as never,
        terminalHost: null as never,
        workspaceStatus: sharedStatus,
        normalizeBrowserUrl: () => null,
        onBrowserUrlChange() {}
      }
    });
    renderer.init?.({
      api: {
        id: "pane.status-cleanup",
        title: "Cleanup",
        updateParameters() {},
        setTitle() {}
      } as never,
      containerApi: null as never,
      title: "Cleanup",
      params: {}
    });

    // initial replay = 1 invocation
    expect(received).toBe(1);
    sharedStatus.set("k", 1);
    expect(received).toBe(2);

    renderer.dispose?.();

    // After dispose, the surviving store should not invoke the disposed
    // pane's handler. Without auto-cleanup the count would keep growing.
    sharedStatus.set("k", 2);
    expect(received).toBe(2);
  });

  it("does not expose the host store dispose() through ctx.workspaceStatus", () => {
    const sharedStatus = createWorkspaceStatusStore();
    let captured: unknown;

    const descriptor = createExternalPaneDescriptor({
      kind: "sample.status-facade",
      mount(_host, context) {
        captured = context.workspaceStatus;
      }
    });

    const renderer = descriptor.createRenderer({
      workspace: makePaneWorkspaceContext({ id: EXTERNAL_ID }),
      options: { id: "pane.status-facade", name: "sample.status-facade" },
      runtime: {
        shellModel: {
          pathGet: async () => ({ ok: true, found: true, value: null }),
          pathList: async () => ({ ok: true, found: true, entries: [] }),
          pathSet: async (_path, value) => ({ ok: true, value }),
          pathCall: async () => ({ ok: true, value: null })
        },
        browserPanelTemplate: null as never,
        terminalHost: null as never,
        workspaceStatus: sharedStatus,
        normalizeBrowserUrl: () => null,
        onBrowserUrlChange() {}
      }
    });
    renderer.init?.({
      api: {
        id: "pane.status-facade",
        title: "Facade",
        updateParameters() {},
        setTitle() {}
      } as never,
      containerApi: null as never,
      title: "Facade",
      params: {}
    });

    // The facade exposes only get/set/subscribe — even an `as any` cast
    // can't reach the host's dispose().
    expect((captured as { dispose?: unknown }).dispose).toBeUndefined();
    // And the host store stays alive.
    sharedStatus.set("k", "alive");
    expect(sharedStatus.get<string>("k")).toBe("alive");
  });

  it("maps external path mounts onto the internal descriptor contract", async () => {
    const descriptor = createExternalPaneDescriptor({
      kind: "sample.mount",
      mount() {},
      pathMount: {
        mountKey: "sample-mount",
        getStateSnapshot: ({ paneId, currentParams }) => ({
          paneId,
          note: currentParams?.note ?? ""
        }),
        setState: async ({ relativePath, value, setParams }) => {
          if (relativePath.join("/") !== "note") {
            throw new Error("unexpected relative path");
          }

          const note = typeof value === "string" ? value : "";
          await setParams({ note });
          return { value: note };
        },
        getStatusSnapshot: ({ currentParams }) => ({
          noteLength: typeof currentParams?.note === "string" ? currentParams.note.length : 0
        })
      }
    });

    const setParamsCalls: Array<Record<string, unknown>> = [];
    const pathMount = descriptor.pathMount;
    if (!pathMount) {
      throw new Error("expected path mount to be defined");
    }

    expect(pathMount.mountKey).toBe("sample-mount");
    expect(
      await pathMount.getStateSnapshot?.({
        paneId: "pane.mount",
        workspace: makePaneWorkspaceContext({ id: EXTERNAL_ID }),
        record: {
          kind: "sample.mount"
        },
        currentParams: {
          note: "seed"
        },
        setParams: async (nextParams) => nextParams,
        patchParams: async (patch) => patch
      })
    ).toEqual({
      paneId: "pane.mount",
      note: "seed"
    });
    expect(
      await pathMount.setState?.(
        {
          paneId: "pane.mount",
          workspace: makePaneWorkspaceContext({ id: EXTERNAL_ID }),
          record: {
            kind: "sample.mount"
          },
          currentParams: {
            note: "seed"
          },
          setParams: async (nextParams) => {
            setParamsCalls.push(nextParams);
            return nextParams;
          },
          patchParams: async (patch) => patch
        },
        ["note"],
        "patched"
      )
    ).toEqual({
      value: "patched"
    });
    expect(setParamsCalls).toEqual([
      {
        note: "patched"
      }
    ]);
    expect(
      await pathMount.getStatusSnapshot?.({
        paneId: "pane.mount",
        workspace: makePaneWorkspaceContext({ id: EXTERNAL_ID }),
        record: {
          kind: "sample.mount"
        },
        currentParams: {
          note: "patched"
        },
        setParams: async (nextParams) => nextParams,
        patchParams: async (patch) => patch
      })
    ).toEqual({
      noteLength: 7
    });
  });

  it("rejects reserved path mount keys at registry registration time", () => {
    const registry = new PaneRegistry();
    const descriptor = createExternalPaneDescriptor({
      kind: "sample.invalid-mount",
      mount() {},
      pathMount: {
        mountKey: "browser",
        getStateSnapshot: () => ({})
      }
    });

    expect(() => registry.register(descriptor)).toThrow(
      "Pane descriptor 'sample.invalid-mount' uses reserved path mount key 'browser'"
    );
  });
});
