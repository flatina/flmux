import { lstatSync } from "node:fs";
import { ModelPathError } from "@flmux/core/shell";
import { createFsPathMapper, type CreateFsBackendOptions } from "./fsBackend";

export interface FsDownloadTarget {
  kind: "file" | "dir";
  realPath: string;
  /** Leaf name from the virtual path — download filename (dir gets `.tar.gz` appended). */
  name: string;
}

export interface FsDownloader {
  open(virtual: string): FsDownloadTarget;
}

/** Read-side resolver for `/api/fs/download` — same binds/containment as `/fs` ops. */
export function createFsDownloader(options: CreateFsBackendOptions): FsDownloader {
  const mapper = createFsPathMapper(options);
  return {
    open(virtual) {
      const { realPath } = mapper.toReal(virtual, "read");
      // toReal already proved realPath inside a bind with no symlink components;
      // map any post-resolution stat failure to a sanitized error (no real path).
      let stats: ReturnType<typeof lstatSync>;
      try {
        stats = lstatSync(realPath);
      } catch {
        throw new ModelPathError("NOT_FOUND", "Path not found");
      }
      const name = virtual.replace(/\/+$/, "").split("/").filter(Boolean).at(-1) ?? "download";
      if (stats.isDirectory()) return { kind: "dir", realPath, name };
      if (stats.isFile()) return { kind: "file", realPath, name };
      throw new ModelPathError("INVALID_PATH", "Path is not a file or directory");
    }
  };
}

/**
 * Stream a directory as gzipped tar via the system `tar` (bsdtar on Windows /
 * GNU tar elsewhere). Native walk + compression, zero JS-side buffering — the
 * archive is never materialized in memory or on disk. cwd is pinned inside the
 * already-validated dir (`-C realDir .`); tar's default no-follow keeps symlinks
 * as link records (no content traversal out of the tree). Client abort kills it.
 */
export function tarGzDirStream(realDir: string): ReadableStream<Uint8Array> {
  const proc = Bun.spawn(["tar", "-czf", "-", "-C", realDir, "."], { stdout: "pipe", stderr: "ignore" });
  const reader = proc.stdout.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      proc.kill();
    }
  });
}

/** RFC 5987 Content-Disposition: ASCII fallback + UTF-8 `filename*` (non-ASCII names survive). */
export function attachmentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  // encodeURIComponent leaves !'()* — not RFC 5987 attr-chars; percent-encode them too.
  const ext = encodeURIComponent(filename).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${ext}`;
}
