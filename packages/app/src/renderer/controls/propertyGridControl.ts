// Standalone grouped property grid (VS-style groups). No flmux imports — data in,
// change out; the caller owns loading/persistence. Reusable beyond preferences.

export type PropertyFieldType = "toggle" | "text" | "number" | "select";

export interface PropertyField {
  key: string;
  label: string;
  type: PropertyFieldType;
  options?: readonly { value: string; label: string }[];
  help?: string;
  value: unknown;
}

export interface PropertyGroup {
  id: string;
  label: string;
  fields: readonly PropertyField[];
}

export interface PropertyGridOptions {
  groups: readonly PropertyGroup[];
  /** Fired on each edit. `value` is the coerced editor value. */
  onChange(groupId: string, key: string, value: unknown): void;
  className?: string;
}

export interface PropertyGridInstance {
  readonly element: HTMLElement;
  dispose(): void;
}

export function mountPropertyGrid(container: HTMLElement, options: PropertyGridOptions): PropertyGridInstance {
  const root = document.createElement("div");
  root.className = options.className ? `property-grid ${options.className}` : "property-grid";

  for (const group of options.groups) {
    root.append(buildGroup(group, options.onChange));
  }
  container.append(root);

  return {
    element: root,
    dispose() {
      root.remove();
    }
  };
}

function buildGroup(group: PropertyGroup, onChange: PropertyGridOptions["onChange"]): HTMLElement {
  const section = document.createElement("section");
  section.className = "property-grid__group";

  const header = document.createElement("button");
  header.type = "button";
  header.className = "property-grid__group-header";
  header.textContent = group.label;
  header.setAttribute("aria-expanded", "true");

  const body = document.createElement("div");
  body.className = "property-grid__group-body";

  header.addEventListener("click", () => {
    const collapsed = section.classList.toggle("property-grid__group--collapsed");
    header.setAttribute("aria-expanded", String(!collapsed));
  });

  for (const field of group.fields) {
    body.append(buildRow(group.id, field, onChange));
  }

  section.append(header, body);
  return section;
}

function buildRow(groupId: string, field: PropertyField, onChange: PropertyGridOptions["onChange"]): HTMLElement {
  const row = document.createElement("label");
  row.className = "property-grid__row";

  const label = document.createElement("span");
  label.className = "property-grid__label";
  label.textContent = field.label;
  if (field.help) label.title = field.help;

  const editor = buildEditor(field, (value) => onChange(groupId, field.key, value));

  row.append(label, editor);
  return row;
}

function buildEditor(field: PropertyField, emit: (value: unknown) => void): HTMLElement {
  if (field.type === "toggle") {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "property-grid__editor property-grid__editor--toggle";
    input.checked = field.value === true;
    input.addEventListener("change", () => emit(input.checked));
    return input;
  }

  if (field.type === "select") {
    const select = document.createElement("select");
    select.className = "property-grid__editor";
    for (const opt of field.options ?? []) {
      const option = document.createElement("option");
      option.value = opt.value;
      option.textContent = opt.label;
      select.append(option);
    }
    select.value = field.value == null ? "" : String(field.value);
    select.addEventListener("change", () => emit(select.value));
    return select;
  }

  const input = document.createElement("input");
  input.className = "property-grid__editor";
  input.type = field.type === "number" ? "number" : "text";
  input.value = field.value == null ? "" : String(field.value);
  input.addEventListener("change", () => {
    if (field.type === "number") {
      const n = input.valueAsNumber;
      emit(Number.isNaN(n) ? null : n);
    } else {
      emit(input.value);
    }
  });
  return input;
}
