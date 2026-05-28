import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  type Stats
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ModelPathError, type FsBackend, type FsEntryKind, type FsListEntry } from "@flmux/core/shell";
import type { ExtensionFsBind, ExtensionFsPolicy } from "@flmux/extension-api";

export interface CreateFsBackendOptions {
  policy: ExtensionFsPolicy;
  projectDir: string;
}

interface NormalizedBind {
  realPath: string;
  virtual: string;
  virtualSegments: string[];
}

interface ParsedPath {
  normalized: string;
  segments: string[];
}

interface ResolvedRealPath {
  realPath: string;
  stats: Stats;
}

const O_NOFOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

export function createFsBackend(options: CreateFsBackendOptions): FsBackend {
  return new NodeFsBackend(options);
}

class NodeFsBackend implements FsBackend {
  private readonly projectRoot: string;
  private readonly unconfined: boolean;
  private readonly binds: NormalizedBind[];

  constructor(options: CreateFsBackendOptions) {
    // Canonicalize once; tolerate a missing dir at ctor — ENOENT surfaces at use.
    this.projectRoot = tryCanonicalizeExisting(options.projectDir) ?? resolve(options.projectDir);
    this.unconfined = options.policy.unconfined;
    this.binds = options.policy.binds.flatMap((bind) => {
      const normalized = normalizeBind(bind);
      return normalized ? [normalized] : [];
    });
  }

  list({ path: inputPath }: { path: string }) {
    if (this.unconfined) {
      const target = this.resolveUnconfined(inputPath);
      if (!target.stats.isDirectory()) {
        throw new ModelPathError("INVALID_PATH", "Path is not a directory");
      }
      return { entries: listDirectory(target.realPath) };
    }

    const parsed = parseVirtualPath(inputPath, { rejectNativeAbsolute: true });
    const matched = this.matchBind(parsed.normalized);
    if (!matched) {
      const entries = this.listVirtualChildren(parsed.normalized);
      if (parsed.normalized === "/" || entries.length > 0) {
        return { entries };
      }
      throw new ModelPathError("NOT_FOUND", "Path not found");
    }

    const target = resolveUnderRoot(matched.realPath, parsed.segments.slice(matched.virtualSegments.length));
    if (!target.stats.isDirectory()) {
      throw new ModelPathError("INVALID_PATH", "Path is not a directory");
    }
    return { entries: listDirectory(target.realPath) };
  }

  read(input: { path: string; maxBytes?: number }) {
    const target = this.unconfined
      ? this.resolveUnconfined(input.path)
      : this.resolveConfined(input.path);
    if (!target.stats.isFile()) {
      throw new ModelPathError("INVALID_PATH", "Path is not a file");
    }
    return readUtf8File(target.realPath, input.maxBytes);
  }

  stat({ path: inputPath }: { path: string }) {
    if (this.unconfined) {
      return toStatResult(this.resolveUnconfined(inputPath).stats);
    }

    const parsed = parseVirtualPath(inputPath, { rejectNativeAbsolute: true });
    const matched = this.matchBind(parsed.normalized);
    if (!matched) {
      const entries = this.listVirtualChildren(parsed.normalized);
      if (parsed.normalized === "/" || entries.length > 0) {
        return { kind: "dir" as const, size: 0, mtimeMs: 0 };
      }
      throw new ModelPathError("NOT_FOUND", "Path not found");
    }

    return toStatResult(resolveUnderRoot(matched.realPath, parsed.segments.slice(matched.virtualSegments.length)).stats);
  }

  private resolveConfined(inputPath: string): ResolvedRealPath {
    const parsed = parseVirtualPath(inputPath, { rejectNativeAbsolute: true });
    const matched = this.matchBind(parsed.normalized);
    if (!matched) {
      const entries = this.listVirtualChildren(parsed.normalized);
      if (entries.length > 0 || parsed.normalized === "/") {
        throw new ModelPathError("INVALID_PATH", "Path is not a file");
      }
      throw new ModelPathError("NOT_FOUND", "Path not found");
    }
    return resolveUnderRoot(matched.realPath, parsed.segments.slice(matched.virtualSegments.length));
  }

  private resolveUnconfined(inputPath: string): ResolvedRealPath {
    const parsed = parseUnconfinedPath(inputPath);
    return resolveUnderRoot(this.projectRoot, parsed.segments);
  }

  private matchBind(virtualPath: string): NormalizedBind | undefined {
    let best: NormalizedBind | undefined;
    for (const bind of this.binds) {
      if (!isVirtualPrefix(virtualPath, bind.virtual)) {
        continue;
      }
      if (!best || bind.virtualSegments.length > best.virtualSegments.length) {
        best = bind;
      }
    }
    return best;
  }

  private listVirtualChildren(virtualPath: string): FsListEntry[] {
    const names = new Set<string>();
    for (const bind of this.binds) {
      const child = firstVirtualChild(virtualPath, bind.virtual);
      if (child) {
        names.add(child);
      }
    }
    return [...names].sort().map((name) => ({ name, kind: "dir" as const }));
  }
}

function normalizeBind(bind: ExtensionFsBind): NormalizedBind | null {
  if (bind.mode !== "ro" && bind.mode !== "rw") {
    return null;
  }
  try {
    const parsed = parseVirtualPath(bind.virtual, { rejectNativeAbsolute: true });
    return {
      realPath: canonicalizeExisting(bind.realPath),
      virtual: parsed.normalized,
      virtualSegments: parsed.segments
    };
  } catch {
    return null;
  }
}

function parseVirtualPath(inputPath: string, options: { rejectNativeAbsolute: boolean }): ParsedPath {
  validateRawPath(inputPath);
  if (options.rejectNativeAbsolute && isNativeAbsoluteEscape(inputPath)) {
    throw new ModelPathError("INVALID_PATH", "Native absolute filesystem paths are not allowed here");
  }

  const segments = splitPathSegments(inputPath);
  return {
    normalized: segments.length === 0 ? "/" : `/${segments.join("/")}`,
    segments
  };
}

function parseUnconfinedPath(inputPath: string): ParsedPath {
  validateRawPath(inputPath);
  // Virtual surface — reject Windows-drive paths; leading "/" is just the
  // virtual-root marker (splitPathSegments strips it).
  if (/^[A-Za-z]:/.test(inputPath) || isWindowsDriveRelative(inputPath)) {
    throw new ModelPathError("INVALID_PATH", "Native absolute filesystem paths are not allowed here");
  }
  const segments = splitPathSegments(inputPath);
  return { normalized: segments.length === 0 ? "/" : `/${segments.join("/")}`, segments };
}

function validateRawPath(inputPath: string): void {
  if (inputPath.includes("\0")) {
    throw new ModelPathError("INVALID_PATH", "NUL bytes are not allowed in filesystem paths");
  }
  const segments = splitPathSegments(inputPath, { allowDotDotCheckOnly: true });
  if (segments.includes("..")) {
    throw new ModelPathError("INVALID_PATH", "Parent path segments are not allowed");
  }
}

function splitPathSegments(inputPath: string, options: { allowDotDotCheckOnly?: boolean } = {}): string[] {
  const normalized = inputPath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (!options.allowDotDotCheckOnly && segments.includes("..")) {
    throw new ModelPathError("INVALID_PATH", "Parent path segments are not allowed");
  }
  return segments;
}

function isNativeAbsoluteEscape(inputPath: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(inputPath) || inputPath.startsWith("\\\\") || inputPath.startsWith("//");
}

function isWindowsDriveRelative(inputPath: string): boolean {
  return /^[A-Za-z]:(?![\\/])/.test(inputPath);
}

// Per-component lstat (rejects symlinks) + final realpath/assert pin inside `root`.
// Residual TOCTOU (Node lacks openat): an ancestor swap mid-walk can escape — accepted for trusted-team.
function resolveUnderRoot(root: string, segments: readonly string[]): ResolvedRealPath {
  let current = root;
  let currentStats = safeLstat(root);
  if (currentStats.isSymbolicLink()) {
    throw new ModelPathError("INVALID_PATH", "Filesystem root is a symbolic link");
  }

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment === "..") {
      throw new ModelPathError("INVALID_PATH", "Parent path segments are not allowed");
    }
    current = join(current, segment);
    currentStats = safeLstat(current);
    if (currentStats.isSymbolicLink()) {
      throw new ModelPathError("INVALID_PATH", "Symbolic links are not allowed in filesystem paths");
    }
    if (i < segments.length - 1 && !currentStats.isDirectory()) {
      throw new ModelPathError("NOT_FOUND", "Path not found");
    }
  }

  const canonical = canonicalizeExisting(current);
  assertInsideRoot(root, canonical);
  return { realPath: canonical, stats: currentStats };
}

function safeLstat(targetPath: string): Stats {
  try {
    return lstatSync(targetPath);
  } catch (error) {
    throw mapFsError(error);
  }
}

function listDirectory(dirPath: string): FsListEntry[] {
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .flatMap((entry): FsListEntry[] => {
        const childPath = join(dirPath, entry.name);
        try {
          const stats = lstatSync(childPath);
          const listed: FsListEntry = {
            name: entry.name,
            kind: kindFromStats(stats),
            mtimeMs: stats.mtimeMs
          };
          if (stats.isFile()) {
            listed.size = stats.size;
          }
          return [listed];
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    throw mapFsError(error);
  }
}

function readUtf8File(filePath: string, maxBytes: number | undefined) {
  const fd = openFileNoFollow(filePath);
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      throw new ModelPathError("INVALID_PATH", "Path is not a file");
    }
    const bytesToRead = Math.min(maxBytes ?? stats.size, stats.size);
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = bytesToRead === 0 ? 0 : readSync(fd, buffer, 0, bytesToRead, 0);
    const slice = buffer.subarray(0, bytesRead);
    const truncated = stats.size > bytesRead;
    return {
      content: (truncated ? trimIncompleteUtf8(slice) : slice).toString("utf8"),
      truncated
    };
  } catch (error) {
    if (error instanceof ModelPathError) throw error;
    throw mapFsError(error);
  } finally {
    closeSync(fd);
  }
}

function tryCanonicalizeExisting(targetPath: string): string | null {
  try {
    return realpathSync.native(targetPath);
  } catch {
    return null;
  }
}

function trimIncompleteUtf8(buf: Buffer): Buffer {
  for (let look = 1; look <= Math.min(4, buf.length); look++) {
    const b = buf[buf.length - look]!;
    if ((b & 0x80) === 0) return buf;              // ASCII → complete
    if ((b & 0xc0) === 0x80) continue;             // continuation → keep walking back
    const expected = (b & 0xe0) === 0xc0 ? 2 : (b & 0xf0) === 0xe0 ? 3 : (b & 0xf8) === 0xf0 ? 4 : 1;
    return look === expected ? buf : buf.subarray(0, buf.length - look);
  }
  return buf;
}

function openFileNoFollow(filePath: string): number {
  try {
    return openSync(filePath, constants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (O_NOFOLLOW !== 0 && (code === "EINVAL" || code === "ENOTSUP")) {
      try {
        return openSync(filePath, constants.O_RDONLY);
      } catch (fallbackError) {
        throw mapFsError(fallbackError);
      }
    }
    throw mapFsError(error);
  }
}

function toStatResult(stats: Stats) {
  return {
    kind: kindFromStats(stats),
    size: stats.size,
    mtimeMs: stats.mtimeMs
  };
}

function kindFromStats(stats: Stats): FsEntryKind {
  if (stats.isDirectory()) return "dir";
  if (stats.isFile()) return "file";
  return "other";
}

function isVirtualPrefix(candidate: string, prefix: string): boolean {
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

function firstVirtualChild(parent: string, childPath: string): string | null {
  if (parent === "/") {
    return childPath.split("/").filter(Boolean)[0] ?? null;
  }
  if (!childPath.startsWith(`${parent}/`)) {
    return null;
  }
  return childPath.slice(parent.length + 1).split("/").filter(Boolean)[0] ?? null;
}

function canonicalizeExisting(targetPath: string): string {
  try {
    return realpathSync.native(targetPath);
  } catch (error) {
    throw mapFsError(error);
  }
}

function assertInsideRoot(root: string, targetPath: string): void {
  const rel = relative(root, targetPath);
  if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
    return;
  }
  throw new ModelPathError("INVALID_PATH", "Path escapes the filesystem root");
}

function mapFsError(error: unknown): ModelPathError {
  if (error instanceof ModelPathError) {
    return error;
  }
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new ModelPathError("NOT_FOUND", "Path not found");
  }
  if (code === "ELOOP") {
    return new ModelPathError("INVALID_PATH", "Symbolic links are not allowed in filesystem paths");
  }
  if (code === "EACCES" || code === "EPERM") {
    return new ModelPathError("NOT_FOUND", "Path not found");
  }
  // Generic — raw fs error messages embed the real host path (defeats /w hiding).
  return new ModelPathError("INTERNAL_ERROR", "Filesystem error");
}
