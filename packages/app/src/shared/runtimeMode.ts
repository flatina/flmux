export type FlmuxRuntimeMode = "desktop" | "web";

// outer-auto: hide outer tabstrip when count==1. outer-always: keep.
// titlebar: render in custom HTML titlebar (frameless). none: never show.
export type WorkspaceTabstripMode = "outer-auto" | "outer-always" | "titlebar" | "none";

export function resolveWorkspaceTabstripMode(input: {
  runtimeMode: FlmuxRuntimeMode;
  platform: NodeJS.Platform;
}): WorkspaceTabstripMode {
  if (input.runtimeMode === "desktop") {
    return input.platform === "win32" ? "titlebar" : "outer-always";
  }
  return "outer-auto";
}
