import { describe, expect, it } from "bun:test";
import type { SequencedShellCoreEvent } from "@flmux/core/shell";
import { AttachmentRegistry } from "../src/main/attachmentRegistry";

function mkEvent(seq: number, attachmentId?: string): SequencedShellCoreEvent {
  return {
    topic: "workspace.activeChanged",
    payload: { id: `workspace.${seq}` },
    seq,
    scope: "attachment",
    targetAttachmentId: attachmentId ?? "a"
  } as SequencedShellCoreEvent;
}

describe("AttachmentRegistry", () => {
  it("ensure() is idempotent and returns the same state", () => {
    const registry = new AttachmentRegistry();
    const first = registry.ensure("a");
    const second = registry.ensure("a");
    expect(first).toBe(second);
    expect(first.attachmentId).toBe("a");
    expect(first.viewId).toBeNull();
  });

  it("ring buffer retains the most recent events up to bufferSize", () => {
    const registry = new AttachmentRegistry({ bufferSize: 3 });
    registry.ensure("a");
    for (let i = 1; i <= 5; i += 1) {
      registry.pushBuffered("a", mkEvent(i));
    }
    const state = registry.get("a")!;
    expect(state.ringBuffer.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it("replayAfter returns events strictly greater than lastAppliedSeq", () => {
    const registry = new AttachmentRegistry({ bufferSize: 5 });
    registry.ensure("a");
    for (let i = 10; i <= 14; i += 1) {
      registry.pushBuffered("a", mkEvent(i));
    }
    const replay = registry.replayAfter("a", 12);
    expect(replay?.map((e) => e.seq)).toEqual([13, 14]);
  });

  it("replayAfter returns null when lastAppliedSeq is older than buffer's oldest", () => {
    const registry = new AttachmentRegistry({ bufferSize: 3 });
    registry.ensure("a");
    // After shift-cap, oldest in buffer is seq 3.
    for (let i = 1; i <= 5; i += 1) registry.pushBuffered("a", mkEvent(i));
    // Client says "I last applied seq 1" — buffer's oldest seq is 3, so the
    // seq range [2..2] is missing. Must signal rebootstrap-required.
    expect(registry.replayAfter("a", 1)).toBeNull();
  });

  it("replayAfter returns empty when buffer is empty", () => {
    const registry = new AttachmentRegistry();
    registry.ensure("a");
    expect(registry.replayAfter("a", 0)).toEqual([]);
  });

  it("attachLive stores viewId and replaces a prior live subscriber", () => {
    const registry = new AttachmentRegistry();
    let firstUnsubs = 0;
    let secondUnsubs = 0;
    registry.attachLive("a", 10, () => firstUnsubs++);
    registry.attachLive("a", 10, () => secondUnsubs++);
    expect(firstUnsubs).toBe(1);
    expect(secondUnsubs).toBe(0);
    expect(registry.get("a")?.viewId).toBe(10);
  });

  it("markDisconnected tears down live subscriber but keeps buffer alive", async () => {
    const registry = new AttachmentRegistry({ graceMs: 10 });
    let liveUnsub = 0;
    let bufferUnsub = 0;
    registry.setBufferSubscriber("a", () => bufferUnsub++);
    registry.attachLive("a", 10, () => liveUnsub++);
    registry.markDisconnected("a", () => {});
    expect(liveUnsub).toBe(1);
    expect(bufferUnsub).toBe(0);
    expect(registry.get("a")?.viewId).toBeNull();
    // Buffer still accepts events during grace.
    registry.pushBuffered("a", mkEvent(1));
    expect(registry.get("a")?.ringBuffer.map((e) => e.seq)).toEqual([1]);
    // Eviction fires after graceMs.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(registry.get("a")).toBeUndefined();
    expect(bufferUnsub).toBe(1);
  });

  it("attachLive cancels a pending disconnect timer (reconnect within grace)", async () => {
    const registry = new AttachmentRegistry({ graceMs: 20 });
    let evictFired = false;
    registry.attachLive("a", 10, () => {});
    registry.markDisconnected("a", () => {
      evictFired = true;
    });
    // Reconnect before grace expires.
    registry.attachLive("a", 11, () => {});
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(evictFired).toBe(false);
    expect(registry.get("a")?.viewId).toBe(11);
  });

  it("resolveByViewId finds live attachments", () => {
    const registry = new AttachmentRegistry();
    registry.attachLive("a", 7, () => {});
    registry.attachLive("b", 8, () => {});
    expect(registry.resolveByViewId(7)?.attachmentId).toBe("a");
    expect(registry.resolveByViewId(9)).toBeUndefined();
  });
});
