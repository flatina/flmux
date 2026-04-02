import type { ViewPropertyHandle, ViewPropertyInfo } from "flmux-sdk";

type Child = HTMLElement | string | null | undefined | false;

export type InspectorProperty = {
  key: string;
  value: unknown;
  readonly: boolean;
  metadata?: ViewPropertyInfo["metadata"];
};

export type CommitFn = (handle: ViewPropertyHandle, property: InspectorProperty, nextValue: unknown) => void;

/** Minimal DOM element builder. Sets DOM properties when possible, falls back to setAttribute. */
export function h(tag: string, attrs?: Record<string, unknown> | null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  let deferredValue: string | undefined;
  if (attrs) {
    for (const [key, val] of Object.entries(attrs)) {
      if (key.startsWith("on") && typeof val === "function") {
        el.addEventListener(key.slice(2).toLowerCase(), val as EventListener);
      } else if (key === "value") {
        deferredValue = String(val ?? "");
      } else if (key in el) {
        (el as any)[key] = val;
      } else {
        el.setAttribute(key, String(val));
      }
    }
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    el.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  if (deferredValue !== undefined) {
    (el as any).value = deferredValue;
  }
  return el;
}

export function mustQuery<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const element = root.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing inspector node: ${selector}`);
  }
  return element as T;
}

export function renderScopeCard(
  card: HTMLElement,
  title: string,
  subtitle: string,
  handle: ViewPropertyHandle | null,
  commit: CommitFn
): void {
  const values = handle?.list() ?? {};
  const schema = handle?.schema() ?? {};
  const properties: InspectorProperty[] = Object.keys(values)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => ({
      key,
      value: values[key],
      readonly: schema[key]?.readonly ?? true,
      metadata: schema[key]?.metadata
    }));

  const head = h("header", { className: "property-inspector-card-head" },
    h("div", { className: "property-inspector-card-title" }, title),
    h("div", { className: "property-inspector-card-meta" }, subtitle)
  );

  const list = h("div", { className: "property-inspector-list" });

  if (!handle || properties.length === 0) {
    list.append(
      h("div", { className: "property-inspector-empty" },
        handle ? "No properties." : "Target unavailable in current snapshot.")
    );
  } else {
    for (const property of properties) {
      list.append(buildPropertyRow(handle, property, commit));
    }
  }

  card.replaceChildren(head, list);
}

function buildPropertyRow(
  handle: ViewPropertyHandle,
  property: InspectorProperty,
  commit: CommitFn
): HTMLElement {
  const key = h("div", { className: "property-inspector-key" },
    property.key,
    buildBadge(property.readonly ? "readonly" : "writable"),
    buildBadge(property.metadata?.valueType ?? "json")
  );

  const valueContainer = h("div", { className: "property-inspector-value" });
  if (property.metadata?.description) {
    valueContainer.append(
      h("div", { className: "property-inspector-card-meta" }, property.metadata.description)
    );
  }
  valueContainer.append(
    property.readonly ? buildReadonlyValue(property.value) : buildEditor(handle, property, commit)
  );

  const row = h("section", { className: "property-inspector-row" }, key, valueContainer);
  row.dataset.key = property.key;
  return row;
}

function buildEditor(
  handle: ViewPropertyHandle,
  property: InspectorProperty,
  commit: CommitFn
): HTMLElement {
  const metadata = property.metadata ?? { valueType: "json" as const };

  if (metadata.valueType === "boolean") {
    return h("input", {
      type: "checkbox",
      checked: Boolean(property.value),
      onChange: (e: Event) => commit(handle, property, (e.target as HTMLInputElement).checked)
    });
  }

  if (metadata.options?.length) {
    const options: HTMLElement[] = [];
    if (metadata.nullable) {
      options.push(h("option", { value: "" }, "(null)"));
    }
    for (const opt of metadata.options) {
      options.push(h("option", { value: String(opt) }, String(opt)));
    }
    return h("select", {
      value: property.value === null ? "" : String(property.value ?? ""),
      onChange: (e: Event) => {
        commit(handle, property,
          normalizeInputValue((e.target as HTMLSelectElement).value, metadata.valueType, metadata.nullable ?? false));
      }
    }, ...options);
  }

  if (metadata.valueType === "json") {
    const textarea = h("textarea", {
      value: JSON.stringify(property.value, null, 2)
    }) as HTMLTextAreaElement;
    return h("div", { className: "property-inspector-value" },
      textarea,
      h("button", {
        type: "button",
        onClick: () => commit(handle, property, JSON.parse(textarea.value))
      }, "Set JSON")
    );
  }

  return h("input", {
    type: metadata.valueType === "number" ? "number" : "text",
    value: property.value === null ? "" : String(property.value ?? ""),
    placeholder: metadata.nullable ? "(null)" : "",
    onChange: (e: Event) => {
      commit(handle, property,
        normalizeInputValue((e.target as HTMLInputElement).value, metadata.valueType, metadata.nullable ?? false));
    },
    onKeydown: (e: Event) => {
      if ((e as KeyboardEvent).key !== "Enter") return;
      e.preventDefault();
      commit(handle, property,
        normalizeInputValue((e.target as HTMLInputElement).value, metadata.valueType, metadata.nullable ?? false));
    }
  });
}

function buildBadge(text: string): HTMLElement {
  return h("span", { className: "property-inspector-badge" }, text);
}

function buildReadonlyValue(value: unknown): HTMLElement {
  return h("pre", { className: "property-inspector-readonly" }, formatValue(value));
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  return JSON.stringify(value, null, 2);
}

function normalizeInputValue(raw: string, type: string | undefined, nullable: boolean): unknown {
  if (nullable && raw === "") return null;
  if (type === "number") {
    const next = Number(raw);
    if (!Number.isFinite(next)) throw new Error(`Invalid number: ${raw}`);
    return next;
  }
  return raw;
}
