import { describe, expect, it } from "bun:test";
import { assertHostPolicy, internalOriginHost, normalizeOrigin, resolveBrowserOrigin } from "../src/main/originPolicy";

describe("assertHostPolicy", () => {
  it("rejects IPv6 / non-IPv4 hosts", () => {
    for (const host of ["::1", "::", "fd00::1", "example.com", "256.0.0.1", "1.2.3.4.5"]) {
      expect(() => assertHostPolicy({ runtimeMode: "web", host, publicOrigin: "http://x:1" })).toThrow(
        /IPv6|unsupported/
      );
    }
  });

  it("rejects desktop non-loopback bind (unauthenticated)", () => {
    expect(() => assertHostPolicy({ runtimeMode: "desktop", host: "0.0.0.0", publicOrigin: undefined })).toThrow(
      /desktop/
    );
    expect(() => assertHostPolicy({ runtimeMode: "desktop", host: "192.168.0.9", publicOrigin: undefined })).toThrow(
      /desktop/
    );
  });

  it("rejects web 0.0.0.0 without publicOrigin", () => {
    expect(() => assertHostPolicy({ runtimeMode: "web", host: "0.0.0.0", publicOrigin: undefined })).toThrow(
      /PUBLIC_ORIGIN/
    );
  });

  it("rejects a malformed publicOrigin", () => {
    expect(() => assertHostPolicy({ runtimeMode: "web", host: "0.0.0.0", publicOrigin: "not a url" })).toThrow(
      /valid URL/
    );
  });

  it("accepts valid configs", () => {
    expect(() =>
      assertHostPolicy({ runtimeMode: "desktop", host: "127.0.0.1", publicOrigin: undefined })
    ).not.toThrow();
    expect(() =>
      assertHostPolicy({ runtimeMode: "desktop", host: "localhost", publicOrigin: undefined })
    ).not.toThrow();
    expect(() => assertHostPolicy({ runtimeMode: "web", host: "192.168.0.9", publicOrigin: undefined })).not.toThrow();
    expect(() =>
      assertHostPolicy({ runtimeMode: "web", host: "0.0.0.0", publicOrigin: "http://192.168.0.9:8443" })
    ).not.toThrow();
    expect(() => assertHostPolicy({ runtimeMode: "web", host: "127.0.0.1", publicOrigin: undefined })).not.toThrow();
  });
});

describe("internalOriginHost", () => {
  it("maps wildcard to loopback, keeps specific IPs", () => {
    expect(internalOriginHost("0.0.0.0")).toBe("127.0.0.1");
    expect(internalOriginHost("192.168.0.9")).toBe("192.168.0.9");
    expect(internalOriginHost("127.0.0.1")).toBe("127.0.0.1");
  });
});

describe("resolveBrowserOrigin", () => {
  it("prefers normalized publicOrigin", () => {
    expect(resolveBrowserOrigin({ host: "0.0.0.0", port: 8443, publicOrigin: "http://x.lan:9000/" })).toBe(
      "http://x.lan:9000"
    );
  });
  it("uses a specific-IP bind as its own origin", () => {
    expect(resolveBrowserOrigin({ host: "192.168.0.9", port: 8443, publicOrigin: undefined })).toBe(
      "http://192.168.0.9:8443"
    );
  });
  it("echoes the bind host for loopback/specific-IP (localhost not collapsed to 127.0.0.1)", () => {
    expect(resolveBrowserOrigin({ host: "127.0.0.1", port: 8443, publicOrigin: undefined })).toBe(
      "http://127.0.0.1:8443"
    );
    expect(resolveBrowserOrigin({ host: "localhost", port: 8443, publicOrigin: undefined })).toBe(
      "http://localhost:8443"
    );
  });
});

describe("normalizeOrigin", () => {
  it("strips trailing slash and path", () => {
    expect(normalizeOrigin("http://x:9000/")).toBe("http://x:9000");
    expect(normalizeOrigin("http://x:9000/foo")).toBe("http://x:9000");
  });
});
