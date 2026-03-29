import { TypedEmitter } from "./emitter";

import type { PropertyChangeEvent, PropertyMetadata } from "../../types/property";
export type { PropertyValueType, PropertyMetadata } from "../../types/property";

export type PropertyChangeCallback = (event: PropertyChangeEvent) => void;

export type ScopeProperty = {
  get: () => unknown;
  set?: (value: unknown) => void;
  metadata?: Partial<PropertyMetadata>;
  readonly: boolean;
};

export class PropertyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PropertyUnavailableError";
  }
}

export abstract class PropertyOwnerBase extends TypedEmitter {
  readonly properties: Record<string, ScopeProperty> = Object.create(null);

  protected finalizeProperties(): void {
    this.registerDecoratedProperties();

    const mutable = this.properties as Record<string, Partial<ScopeProperty> | ScopeProperty>;
    for (const [key, property] of Object.entries(mutable)) {
      if (typeof property.get !== "function") {
        throw new Error(`Property "${key}" is missing a getter`);
      }
      const readonly = property.readonly ?? typeof property.set !== "function";
      const finalized: ScopeProperty = {
        get: property.get,
        set: property.set,
        metadata: property.metadata,
        readonly
      };
      Object.freeze(finalized);
      mutable[key] = finalized;
    }
    Object.freeze(this.properties);
  }

  get(key: string): unknown {
    const property = this.properties[key];
    if (!property) return undefined;
    try {
      return property.get();
    } catch (error) {
      if (error instanceof PropertyUnavailableError) return undefined;
      throw error;
    }
  }

  set(key: string, value: unknown): unknown {
    const property = this.properties[key];
    if (!property?.set) throw new Error(`Property is readonly: ${key}`);
    const prev = this.get(key);
    property.set(value);
    const next = this.get(key);
    if (!Object.is(prev, next)) {
      this.onPropertyChanged(key, next, prev);
      this.afterWrite(key, prev, next);
    }
    return next;
  }

  notify(key: string, previousValue: unknown): void {
    const value = this.get(key);
    if (value !== undefined) this.onPropertyChanged(key, value, previousValue);
  }

  values(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(this.properties)) {
      const value = this.get(key);
      if (value !== undefined) result[key] = value;
    }
    return result;
  }

  schema(): Record<string, { readonly: boolean; metadata?: Partial<PropertyMetadata> }> {
    const result: Record<string, { readonly: boolean; metadata?: Partial<PropertyMetadata> }> = {};
    for (const [key, property] of Object.entries(this.properties)) {
      result[key] = { readonly: property.readonly, metadata: property.metadata };
    }
    return result;
  }

  protected onPropertyChanged(key: string, value: unknown, previousValue: unknown): void {
    this.emit("change", key, value, previousValue);
    this.emit(`change:${key}`, value, previousValue);
  }

  protected afterWrite(_key: string, _previousValue: unknown, _nextValue: unknown): void {}

  private registerDecoratedProperties(): void {
    const prototypes: object[] = [];
    let current = Object.getPrototypeOf(this);
    while (current && current !== PropertyOwnerBase.prototype) {
      prototypes.unshift(current);
      current = Object.getPrototypeOf(current);
    }

    for (const proto of prototypes) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === "constructor") continue;
        const method = Reflect.get(proto, name) as DecoratedMethod | undefined;
        const tag = method?.[PROP_TAG];
        if (!tag) continue;

        const mutable = this.properties as Record<string, Partial<ScopeProperty>>;
        const existing = mutable[tag.key] ?? {};
        if (tag.kind === "get") {
          existing.get = method.bind(this) as () => unknown;
        } else {
          existing.set = method.bind(this) as (value: unknown) => void;
        }
        if (tag.metadata) {
          existing.metadata = { ...existing.metadata, ...tag.metadata };
        }
        if (tag.readonly !== undefined) {
          existing.readonly = tag.readonly;
        }
        mutable[tag.key] = existing;
      }
    }
  }
}

// Used by decorators.ts to tag methods — not part of public API
export const PROP_TAG = Symbol("flmux.prop");
export type PropTag = { key: string; kind: "get" | "set"; metadata?: Partial<PropertyMetadata>; readonly?: boolean };
export type DecoratedMethod = ((...args: never[]) => unknown) & { [PROP_TAG]?: PropTag };
