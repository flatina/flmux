export type FlmuxRuntimeMode = "desktop" | "web";

export interface FlmuxRendererLifecyclePolicy {
  restoreSession: boolean;
  restoreTerminals: boolean;
  persistSession: boolean;
}

export function getFlmuxRendererLifecyclePolicy(mode: FlmuxRuntimeMode): FlmuxRendererLifecyclePolicy {
  if (mode === "web") {
    return {
      restoreSession: false,
      restoreTerminals: false,
      persistSession: false
    };
  }

  return {
    restoreSession: true,
    restoreTerminals: true,
    persistSession: true
  };
}
