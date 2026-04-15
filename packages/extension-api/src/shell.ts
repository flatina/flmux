import type {
  PathCallResult as CoreShellPathCallResult,
  PathErrorCode as CorePathErrorCode,
  PathGetResult as CoreShellPathGetResult,
  PathListResult as CoreShellPathListResult,
  PathSetResult as CoreShellPathSetResult,
  ShellPathEntry as CoreShellPathEntry,
  ShellPathNodeKind as CoreShellPathNodeKind
} from "@flmux/core/shell";

export type ShellPathNodeKind = CoreShellPathNodeKind;
export type PathErrorCode = CorePathErrorCode;
export type ShellPathEntry = CoreShellPathEntry;
export type ShellPathGetResult = CoreShellPathGetResult;
export type ShellPathListResult = CoreShellPathListResult;
export type ShellPathSetResult = CoreShellPathSetResult;
export type ShellPathCallResult = CoreShellPathCallResult;

export interface ShellClient {
  get(path: string): Promise<ShellPathGetResult>;
  list(path: string): Promise<ShellPathListResult>;
  set(path: string, value: unknown): Promise<ShellPathSetResult>;
  call(path: string, args?: Record<string, unknown>): Promise<ShellPathCallResult>;
}
