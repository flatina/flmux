export type FlmuxRuntimeMode = "desktop" | "web";

export interface FlmuxRendererLifecyclePolicy {
  restoreSession: boolean;
  persistSession: boolean;
}

export function getFlmuxRendererLifecyclePolicy(mode: FlmuxRuntimeMode): FlmuxRendererLifecyclePolicy {
  if (mode === "web") {
    return {
      restoreSession: false,
      persistSession: false
    };
  }

  return {
    restoreSession: true,
    persistSession: true
  };
}
