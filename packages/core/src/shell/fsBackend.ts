import type { Awaitable } from "./types";

export type FsEntryKind = "dir" | "file" | "other";

export interface FsListEntry {
  name: string;
  kind: FsEntryKind;
  size?: number;
  mtimeMs?: number;
}

export interface FsListResult {
  entries: FsListEntry[];
}

export interface FsReadResult {
  content: string;
  truncated: boolean;
}

export interface FsStatResult {
  kind: FsEntryKind;
  size: number;
  mtimeMs: number;
}

export interface FsWriteResult {
  bytesWritten: number;
}

export interface FsCreateResult {
  created: true;
}

export interface FsMkdirResult {
  created: true;
}

export interface FsRenameResult {
  renamed: true;
}

export interface FsDeleteResult {
  deleted: true;
  kind: FsEntryKind;
}

export interface FsCopyResult {
  copied: true;
  kind: FsEntryKind;
}

export interface FsBackend {
  list(input: { path: string }): Awaitable<FsListResult>;
  read(input: { path: string; maxBytes?: number }): Awaitable<FsReadResult>;
  stat(input: { path: string }): Awaitable<FsStatResult>;
  write(input: { path: string; content: string | Uint8Array }): Awaitable<FsWriteResult>;
  /** No-clobber empty-file create (fails if exists). */
  create(input: { path: string }): Awaitable<FsCreateResult>;
  mkdir(input: { path: string }): Awaitable<FsMkdirResult>;
  rename(input: { from: string; to: string }): Awaitable<FsRenameResult>;
  delete(input: { path: string; recursive?: boolean }): Awaitable<FsDeleteResult>;
  /** Recursive copy. Source needs read access; dest needs rw + no-clobber. Cross-bind allowed. */
  copy(input: { from: string; to: string }): Awaitable<FsCopyResult>;
}
