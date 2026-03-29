import type { PaneSourceDescriptor } from "../../types/setup";

export const BUILTIN_PANE_SOURCES = [
  {
    qualifiedId: "terminal",
    icon: ">_",
    label: "Terminal",
    order: 20,
    defaultPlacement: "auto",
    options: undefined,
    createLeaf() {
      return { kind: "terminal" } as const;
    }
  }
] as const satisfies ReadonlyArray<{
  qualifiedId: string;
  icon: string;
  label: string;
  order: number;
  defaultPlacement: PaneSourceDescriptor["defaultPlacement"];
  createLeaf: PaneSourceDescriptor["createLeaf"];
  options?: PaneSourceDescriptor["options"];
}>;

export function findBuiltinPaneSource(id: string) {
  return BUILTIN_PANE_SOURCES.find((source) => source.qualifiedId === id);
}
