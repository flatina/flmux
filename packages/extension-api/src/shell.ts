/**
 * Types mirror `@flmux/core/shell/types` for structural compatibility — the
 * host speaks the same shapes at runtime. Keep this file pure types; no
 * runtime imports from core, so extensions don't need `@flmux/core` in their
 * dependency graph.
 */

export type ShellPathNodeKind = "leaf" | "object" | "collection" | "action";

export type PathErrorCode =
  | "NOT_FOUND"
  | "NOT_WRITABLE"
  | "NOT_CALLABLE"
  | "INVALID_VALUE"
  | "INVALID_PATH"
  | "ALREADY_EXISTS"
  | "NOT_EMPTY"
  | "NO_CURRENT_PANE"
  | "NOT_SUPPORTED"
  | "INTERNAL_ERROR";

export interface ShellPathEntry {
  name: string;
  path: string;
  kind: ShellPathNodeKind;
  writable: boolean;
}

export type ShellPathGetResult =
  | { ok: true; found: boolean; value: unknown }
  | { ok: false; code: PathErrorCode; error: string };

export type ShellPathListResult =
  | { ok: true; found: boolean; entries: ShellPathEntry[] }
  | { ok: false; code: PathErrorCode; error: string };

export type ShellPathSetResult = { ok: true; value: unknown } | { ok: false; code: PathErrorCode; error: string };

export type ShellPathCallResult = { ok: true; value: unknown } | { ok: false; code: PathErrorCode; error: string };

export interface ShellClient {
  get(path: string): Promise<ShellPathGetResult>;
  list(path: string): Promise<ShellPathListResult>;
  set(path: string, value: unknown): Promise<ShellPathSetResult>;
  call(path: string, args?: Record<string, unknown>): Promise<ShellPathCallResult>;
}
