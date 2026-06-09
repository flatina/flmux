// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${...}` templates are the unit under test
import { describe, expect, it } from "bun:test";
import { renderAppTemplate } from "../src/shared/appTemplate";
import { FLMUX_APP_VERSION } from "../src/version";
import pkg from "../package.json";

const vars = { appName: "Acme", appVersion: "0.2.0", host: "host.example" };

describe("renderAppTemplate", () => {
  it("substitutes known vars", () => {
    expect(renderAppTemplate("${appName} v${appVersion}", vars)).toBe("Acme v0.2.0");
    expect(renderAppTemplate("${appName} @ ${host}", vars)).toBe("Acme @ host.example");
  });

  it("leaves unknown tokens verbatim (typo stays visible)", () => {
    expect(renderAppTemplate("${appName} ${nope}", vars)).toBe("Acme ${nope}");
  });

  it("does not match inherited Object keys", () => {
    expect(renderAppTemplate("${toString}|${constructor}|${hasOwnProperty}", vars)).toBe(
      "${toString}|${constructor}|${hasOwnProperty}"
    );
  });

  it("renders an empty host without leaving a token", () => {
    expect(renderAppTemplate("${appName}@${host}", { ...vars, host: "" })).toBe("Acme@");
  });

  it("is a plain string replace, not eval", () => {
    expect(renderAppTemplate("${appName}${1+1}", vars)).toBe("Acme${1+1}");
  });
});

describe("FLMUX_APP_VERSION", () => {
  it("is single-sourced from package.json (no drift)", () => {
    expect(FLMUX_APP_VERSION).toBe(pkg.version);
    expect(FLMUX_APP_VERSION.length).toBeGreaterThan(0);
  });
});
