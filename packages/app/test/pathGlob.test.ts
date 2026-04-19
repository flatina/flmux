import { describe, expect, it } from "bun:test";
import { matchPathGlob, matchAnyPathGlob } from "../src/main/auth/pathGlob";

describe("path glob matcher (B3 ACL)", () => {
  it("matches literal paths exactly", () => {
    expect(matchPathGlob("/status/app", "/status/app")).toBe(true);
    expect(matchPathGlob("/status/app", "/status/app/title")).toBe(false);
    expect(matchPathGlob("/status/app", "/status")).toBe(false);
  });

  it("`*` matches within a single segment (not across `/`)", () => {
    expect(matchPathGlob("/workspaces/*/setActive", "/workspaces/ws.1/setActive")).toBe(true);
    expect(matchPathGlob("/workspaces/*/setActive", "/workspaces/ws.foo/setActive")).toBe(true);
    expect(matchPathGlob("/workspaces/*/setActive", "/workspaces/ws.1/nested/setActive")).toBe(false);
    expect(matchPathGlob("/workspaces/*/setActive", "/workspaces/setActive")).toBe(false);
  });

  it("`**` matches zero or more segments", () => {
    expect(matchPathGlob("/status/**", "/status")).toBe(true);
    expect(matchPathGlob("/status/**", "/status/app")).toBe(true);
    expect(matchPathGlob("/status/**", "/status/app/title")).toBe(true);
    expect(matchPathGlob("/status/**", "/panes/new")).toBe(false);
  });

  it("`**` is not greedy across segment boundaries when followed by more pattern", () => {
    expect(matchPathGlob("/workspaces/**/close", "/workspaces/ws.1/close")).toBe(true);
    expect(matchPathGlob("/workspaces/**/close", "/workspaces/ws.1/nested/close")).toBe(true);
    expect(matchPathGlob("/workspaces/**/close", "/workspaces/ws.1/nested/other")).toBe(false);
  });

  it("`*` inside a segment matches partial literals", () => {
    expect(matchPathGlob("/panes/pane.*", "/panes/pane.alpha")).toBe(true);
    expect(matchPathGlob("/panes/pane.*", "/panes/notpane")).toBe(false);
  });

  it("matchAnyPathGlob returns true on first hit, false on no match", () => {
    const patterns = ["/status/**", "/panes/*/close"];
    expect(matchAnyPathGlob(patterns, "/status/app")).toBe(true);
    expect(matchAnyPathGlob(patterns, "/panes/pane.x/close")).toBe(true);
    expect(matchAnyPathGlob(patterns, "/workspaces/ws.1")).toBe(false);
    expect(matchAnyPathGlob([], "/status")).toBe(false);
  });

  it("handles root `/**` as 'allow all'", () => {
    expect(matchPathGlob("/**", "/")).toBe(true);
    expect(matchPathGlob("/**", "/status")).toBe(true);
    expect(matchPathGlob("/**", "/panes/x/terminal/attach")).toBe(true);
  });
});
