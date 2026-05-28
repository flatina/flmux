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

export interface FsBackend {
  list(input: { path: string }): Awaitable<FsListResult>;
  read(input: { path: string; maxBytes?: number }): Awaitable<FsReadResult>;
  stat(input: { path: string }): Awaitable<FsStatResult>;
  write(input: { path: string; content: string }): Awaitable<FsWriteResult>;
}
