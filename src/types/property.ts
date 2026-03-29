import type { PaneId, TabId } from "./ids";

export type PropertyScope = "app" | "workspace" | "pane";
export type PropertyValueType = "string" | "number" | "boolean" | "json";

export interface PropertyMetadata {
  valueType?: PropertyValueType;
  nullable?: boolean;
  options?: Array<string | number | boolean>;
  description?: string;
}

export interface PropertyInfo {
  readonly: boolean;
  metadata?: PropertyMetadata;
}

export interface PropertyHandle {
  get: (key: string) => unknown;
  list: () => Record<string, unknown>;
  schema: () => Record<string, PropertyInfo>;
  set: (key: string, value: unknown) => void;
}

export type PropertyChangeEvent = {
  scope: PropertyScope;
  targetId: PaneId | TabId | null;
  key: string;
  value: unknown;
  previousValue: unknown;
  timestamp: number;
};
