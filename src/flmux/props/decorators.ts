import type { PropertyMetadata } from "./property";
import { PROP_TAG, type DecoratedMethod, type PropTag } from "./property";

export type PropOptions = {
  description?: string;
  type?: PropertyMetadata["valueType"];
  nullable?: boolean;
  options?: Array<string | number | boolean>;
  readonly?: boolean;
};

export function prop(keyOrOptions?: string | PropOptions, maybeOptions?: PropOptions) {
  const explicitKey = typeof keyOrOptions === "string" ? keyOrOptions : null;
  const options = (typeof keyOrOptions === "string" ? maybeOptions : keyOrOptions) ?? {};

  return function decorate(
    valueOrTarget: (...args: never[]) => unknown | object,
    contextOrKey: ClassMethodDecoratorContext | string | symbol,
    maybeDescriptor?: TypedPropertyDescriptor<(...args: never[]) => unknown>
  ) {
    if (typeof contextOrKey === "object" && contextOrKey !== null && "kind" in contextOrKey) {
      if (contextOrKey.kind !== "method") throw new Error("@prop can only decorate methods");
      (valueOrTarget as DecoratedMethod)[PROP_TAG] = buildTag(String(contextOrKey.name), explicitKey, options);
      return;
    }

    const propertyKey = String(contextOrKey);
    const descriptor = maybeDescriptor ?? Object.getOwnPropertyDescriptor(valueOrTarget as object, propertyKey);
    if (!descriptor || typeof descriptor.value !== "function") {
      throw new Error(`@prop target is not a method: ${propertyKey}`);
    }
    (descriptor.value as DecoratedMethod)[PROP_TAG] = buildTag(propertyKey, explicitKey, options);
  };
}

function buildTag(methodName: string, explicitKey: string | null, options: PropOptions): PropTag {
  const key = explicitKey ?? inferKey(methodName);
  if (!key) throw new Error(`@prop requires an explicit key for method "${methodName}"`);
  return {
    key,
    kind: inferKind(methodName, explicitKey),
    metadata: options.type || options.description || options.nullable || options.options
      ? {
          ...(options.type ? { valueType: options.type } : {}),
          ...(options.description ? { description: options.description } : {}),
          ...(options.nullable ? { nullable: true } : {}),
          ...(options.options ? { options: options.options } : {})
        }
      : undefined,
    readonly: options.readonly
  };
}

function inferKey(methodName: string): string | null {
  if (methodName.startsWith("get") || methodName.startsWith("set")) {
    const rest = methodName.slice(3);
    return rest ? rest.charAt(0).toLowerCase() + rest.slice(1) : null;
  }
  return null;
}

function inferKind(methodName: string, explicitKey: string | null): "get" | "set" {
  if (methodName.startsWith("get")) return "get";
  if (methodName.startsWith("set")) return "set";
  throw new Error(
    explicitKey
      ? `Explicit property key requires get*/set* naming: "${methodName}"`
      : `Unable to infer property accessor kind from "${methodName}"`
  );
}
