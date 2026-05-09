import { describe, expect, it } from "bun:test";
import type { SequencedShellCoreEvent } from "@flmux/core/shell";
import { eventToReadPath } from "../src/main/auth/eventAclPath";

function mkEvent(partial: Partial<SequencedShellCoreEvent>): SequencedShellCoreEvent {
  return {
    topic: "app.titleChanged",
    payload: { title: "x" },
    seq: 1,
    scope: "all",
    ...partial
  } as SequencedShellCoreEvent;
}

describe("eventToReadPath (B3 broadcast filter)", () => {
  it("maps workspace/pane events to /status/workspaces and /status/panes paths", () => {
    expect(
      eventToReadPath(
        mkEvent({
          topic: "workspace.added",
          payload: { id: "ws.1", title: "W", defaultTitle: "W" }
        } as Partial<SequencedShellCoreEvent>)
      )
    ).toBe("/status/workspaces/ws.1");
    expect(
      eventToReadPath(
        mkEvent({
          topic: "pane.titleChanged",
          payload: { paneId: "pane.x", workspaceId: "ws.1", title: "T" }
        } as Partial<SequencedShellCoreEvent>)
      )
    ).toBe("/status/panes/pane.x");
    expect(
      eventToReadPath(
        mkEvent({ topic: "app.titleChanged", payload: { title: "Flmux" } } as Partial<SequencedShellCoreEvent>)
      )
    ).toBe("/status/app/title");
  });

  it("maps slot-scoped active changes to /status/clients/{aid}/currentWorkspace", () => {
    expect(
      eventToReadPath(
        mkEvent({
          topic: "workspace.activeChanged",
          payload: { id: "ws.1" },
          scope: "client",
          targetClientId: "web_abc"
        } as Partial<SequencedShellCoreEvent>)
      )
    ).toBe("/status/clients/web_abc/currentWorkspace");
  });

  it("returns null for slot-scoped events missing targetClientId (structural)", () => {
    expect(
      eventToReadPath(
        mkEvent({
          topic: "workspace.activeChanged",
          payload: { id: "ws.1" },
          scope: "client"
        } as Partial<SequencedShellCoreEvent>)
      )
    ).toBeNull();
  });
});
