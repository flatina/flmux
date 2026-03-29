import { describe, expect, test } from "bun:test";
import { PropertyOwnerBase } from "./property";
import { prop } from "./decorators";

describe("property decorators", () => {
  test("auto-registers getters/setters via @prop, get/set works", () => {
    class SampleScope extends PropertyOwnerBase {
      private title = "hello";

      constructor() {
        super();
        this.finalizeProperties();
      }

      @prop({ description: "Window title" })
      getTitle(): string {
        return this.title;
      }

      @prop()
      setTitle(value: unknown): void {
        this.title = String(value);
      }
    }

    const scope = new SampleScope();

    expect(scope.get("title")).toBe("hello");
    scope.set("title", "world");
    expect(scope.get("title")).toBe("world");
    expect(scope.properties["title"]!.metadata).toEqual({ description: "Window title" });
    expect(scope.properties["title"]!.readonly).toBe(false);
  });

  test("set emits change events", () => {
    class TestScope extends PropertyOwnerBase {
      value = "a";
      constructor() { super(); this.finalizeProperties(); }
      @prop() getValue(): string { return this.value; }
      @prop() setValue(v: unknown): void { this.value = String(v); }
    }

    const scope = new TestScope();
    const changes: Array<{ key: string; value: unknown; prev: unknown }> = [];
    scope.on("change", (key, value, prev) => changes.push({ key: key as string, value, prev }));

    scope.set("value", "b");
    expect(changes).toEqual([{ key: "value", value: "b", prev: "a" }]);
  });

  test("values() returns all readable properties", () => {
    class TestScope extends PropertyOwnerBase {
      constructor() { super(); this.finalizeProperties(); }
      @prop() getA(): string { return "aa"; }
      @prop() getB(): number { return 42; }
    }

    const scope = new TestScope();
    expect(scope.values()).toEqual({ a: "aa", b: 42 });
  });

  test("requires explicit dotted keys", () => {
    expect(() => {
      class InvalidScope extends PropertyOwnerBase {
        constructor() { super(); this.finalizeProperties(); }
        @prop() browserUrl(): string { return "https://example.com"; }
      }
      return new InvalidScope();
    }).toThrow("@prop requires an explicit key");
  });
});
