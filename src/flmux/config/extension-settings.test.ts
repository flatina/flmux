import { describe, expect, test } from "bun:test";
import { disableExtension, enableExtension, isExtensionDisabled } from "./extension-settings";

describe("extension-settings", () => {
  test("isExtensionDisabled returns false for empty disabled list", () => {
    expect(isExtensionDisabled({ disabled: [] }, "foo")).toBe(false);
  });

  test("isExtensionDisabled returns true when id is in disabled list", () => {
    expect(isExtensionDisabled({ disabled: ["foo", "bar"] }, "foo")).toBe(true);
  });

  test("disableExtension adds id to disabled list", () => {
    const result = disableExtension({ disabled: [] }, "foo");
    expect(result.disabled).toEqual(["foo"]);
  });

  test("disableExtension is idempotent", () => {
    const result = disableExtension({ disabled: ["foo"] }, "foo");
    expect(result.disabled).toEqual(["foo"]);
  });

  test("enableExtension removes id from disabled list", () => {
    const result = enableExtension({ disabled: ["foo", "bar"] }, "foo");
    expect(result.disabled).toEqual(["bar"]);
  });

  test("enableExtension is idempotent", () => {
    const result = enableExtension({ disabled: ["bar"] }, "foo");
    expect(result.disabled).toEqual(["bar"]);
  });
});
