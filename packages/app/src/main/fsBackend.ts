import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeSync,
  type Dirent,
  type Stats
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ModelPathError, type FsBackend, type FsEntryKind, type FsListEntry } from "@flmux/core/shell";
import type { ExtensionFsBind, ExtensionFsPolicy } from "@flmux/extension-api";

export interface CreateFsBackendOptions {
  policy: ExtensionFsPolicy;
  projectDir: string;
}

interface NormalizedBind {
  realPath: string;
  mode: "ro" | "rw";
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

/** Chunked upload — stages outside the bind, atomic-renames on `final`. */
export interface FsUploader {
  upload(
    virtual: string,
    body: AsyncIterable<Uint8Array>,
    options: { uploadId: string; offset: number; final: boolean; overwrite: boolean; maxBytes: number }
  ): Promise<{ size: number; committed: boolean }>;
}

export interface CreateFsUploaderOptions extends CreateFsBackendOptions {
  /** flmux-managed, outside every bind, same volume as the user's targets (atomic rename). */
  stagingDir: string;
}

// Module-side (uploader is per-request); the TTL also guards live uploads (touched each chunk).
const STAGING_TTL_MS = 60 * 60 * 1000;
const STAGING_SWEEP_THROTTLE_MS = 60 * 1000;
const stagingLastSweptMs = new Map<string, number>();

export function createFsUploader(options: CreateFsUploaderOptions): FsUploader {
  const projectRoot = tryCanonicalizeExisting(options.projectDir) ?? resolve(options.projectDir);
  const unconfined = options.policy.unconfined;
  const binds = options.policy.binds.flatMap((b) => {
    const n = normalizeBind(b);
    return n ? [n] : [];
  });
  const stagingDir = options.stagingDir;

  function resolveWritableRoot(virtual: string): { root: string; segments: string[] } {
    if (unconfined) {
      return { root: projectRoot, segments: parseUnconfinedPath(virtual).segments };
    }
    const parsed = parseVirtualPath(virtual, { rejectNativeAbsolute: true });
    const matched = matchBind(binds, parsed.normalized);
    if (!matched) throw new ModelPathError("NOT_FOUND", "Path not found");
    if (matched.mode !== "rw") throw new ModelPathError("NOT_WRITABLE", "Path is not writable");
    return { root: matched.realPath, segments: parsed.segments.slice(matched.virtualSegments.length) };
  }

  // Skip when the parent doesn't exist yet (parents are made at commit, which re-checks).
  function preflightNoClobber(root: string, parentSegments: readonly string[], leaf: string, overwrite: boolean): void {
    let parentReal: string;
    try {
      parentReal = resolveUnderRoot(root, parentSegments).realPath;
    } catch (error) {
      if (error instanceof ModelPathError && error.code === "NOT_FOUND") return;
      throw error;
    }
    assertLeafAbsentOrFile(join(parentReal, leaf), { allowExisting: overwrite });
  }

  return {
    async upload(virtual, body, { uploadId, offset, final, overwrite, maxBytes }) {
      if (!/^[a-z0-9]{8,64}$/i.test(uploadId)) {
        throw new ModelPathError("INVALID_VALUE", "invalid uploadId");
      }
      const now = Date.now();
      // rw-gate re-checked per chunk (mid-upload role demotion → NOT_WRITABLE).
      const { root, segments } = resolveWritableRoot(virtual);
      if (segments.length === 0) throw new ModelPathError("INVALID_PATH", "Path is not a file");
      const leaf = segments[segments.length - 1]!;
      validateLeafName(leaf);
      for (const segment of segments.slice(0, -1)) validateLeafName(segment);

      const stagedDir = ensureStagingDirNoFollow(stagingDir);
      const stagingFile = join(stagedDir, stagingName(root, segments, uploadId));

      let position = offset;
      let fd: number;
      if (offset === 0) {
        sweepStagingDir(stagedDir, now);
        preflightNoClobber(root, segments.slice(0, -1), leaf, overwrite);
        // O_EXCL refuses a planted symlink even where O_NOFOLLOW is a no-op (Windows).
        try {
          fd = openSync(stagingFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
        } catch (error) {
          throw mapFsError(error);
        }
      } else {
        let st: Stats;
        try {
          st = lstatSync(stagingFile);
        } catch {
          throw new ModelPathError("NOT_FOUND", "No upload in progress");
        }
        if (st.isSymbolicLink() || !st.isFile()) {
          throw new ModelPathError("INVALID_PATH", "Upload target is not a file");
        }
        // Past-TTL = expired (matches GC), so a racing sweep can't unlink under the writer.
        if (now - st.mtimeMs > STAGING_TTL_MS) {
          safeUnlink(stagingFile);
          throw new ModelPathError("NOT_FOUND", "Upload expired");
        }
        if (st.size !== offset) {
          throw new ModelPathError("INVALID_VALUE", `offset ${offset} does not match current size ${st.size}`);
        }
        try {
          fd = openSync(stagingFile, constants.O_WRONLY | O_NOFOLLOW, 0o600);
        } catch (error) {
          throw mapFsError(error);
        }
      }

      try {
        for await (const chunk of body) {
          if (chunk.length === 0) continue;
          if (position + chunk.length > maxBytes) {
            throw new ModelPathError("INVALID_VALUE", `Upload exceeds the ${maxBytes}-byte limit`);
          }
          const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          let written = 0;
          while (written < buf.length) {
            const n = writeSync(fd, buf, written, buf.length - written, position + written);
            if (n === 0) throw new Error("writeSync returned 0");
            written += n;
          }
          position += buf.length;
        }
      } catch (error) {
        closeSync(fd);
        // Drop on cap breach (unrecoverable); keep otherwise — GC reaps a stalled file.
        if (error instanceof ModelPathError && error.code === "INVALID_VALUE") safeUnlink(stagingFile);
        if (error instanceof ModelPathError) throw error;
        throw mapFsError(error);
      }
      closeSync(fd);

      if (!final) return { size: position, committed: false };

      // Parents made now, not at offset 0 — an abandoned upload leaves no target dirs.
      const parentDir = mkdirpNoFollow(root, segments.slice(0, -1));
      const leafPath = join(parentDir, leaf);
      assertLeafAbsentOrFile(leafPath, { allowExisting: overwrite });
      materializeStaging(stagingFile, leafPath, overwrite);
      return { size: position, committed: true };
    }
  };
}

// Target-path hash: a chunk/final for another path misses these bytes; uploadId is per-file.
function stagingName(root: string, segments: readonly string[], uploadId: string): string {
  const key = `${root}\x00${segments.join("/")}`;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return `${hash}.${uploadId}`;
}

// No-follow: an unconfined user can reach this tree via its own `/fs`.
function ensureStagingDirNoFollow(dir: string): string {
  const base = dirname(dir);
  mkdirSync(base, { recursive: true });
  if (lstatSync(base).isSymbolicLink()) {
    throw new ModelPathError("INVALID_PATH", "Staging base is a symbolic link");
  }
  let st: Stats | null = null;
  try {
    st = lstatSync(dir);
  } catch {
    st = null;
  }
  if (st) {
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new ModelPathError("INVALID_PATH", "Staging dir is not a directory");
    }
    return dir;
  }
  try {
    mkdirSync(dir);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw mapFsError(error);
  }
  return dir;
}

// Set lastSweptMs before the readdir and keep this sync, else concurrent offset-0 double-sweeps.
function sweepStagingDir(dir: string, now: number): void {
  const last = stagingLastSweptMs.get(dir) ?? 0;
  if (now - last < STAGING_SWEEP_THROTTLE_MS) return;
  stagingLastSweptMs.set(dir, now);
  let names: string[];
  try {
    const ds = lstatSync(dir);
    if (ds.isSymbolicLink() || !ds.isDirectory()) return;
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const p = join(dir, name);
    try {
      const st = lstatSync(p);
      if (st.isFile() && now - st.mtimeMs > STAGING_TTL_MS) unlinkSync(p);
    } catch {}
  }
}

// renameSync replaces on POSIX/modern Windows (no pre-unlink). EXDEV (staging≠target
// volume) fails loudly rather than copying through the target dir.
function materializeStaging(stagingFile: string, leafPath: string, overwrite: boolean): void {
  try {
    renameSync(stagingFile, leafPath);
    return;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "EXDEV") {
      safeUnlink(stagingFile);
      throw new ModelPathError("INTERNAL_ERROR", "Upload staging and target are on different volumes");
    }
    if (overwrite && (code === "EEXIST" || code === "EPERM" || code === "EACCES")) {
      safeUnlink(leafPath);
      try {
        renameSync(stagingFile, leafPath);
        return;
      } catch (retryError) {
        throw mapFsError(retryError);
      }
    }
    throw mapFsError(error);
  }
}

function assertLeafAbsentOrFile(leafPath: string, { allowExisting }: { allowExisting: boolean }): void {
  let st: Stats;
  try {
    st = lstatSync(leafPath);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    throw new ModelPathError("INVALID_PATH", "Symbolic links are not allowed in filesystem paths");
  }
  if (!st.isFile()) {
    throw new ModelPathError("INVALID_PATH", "Path is not a file");
  }
  if (!allowExisting) {
    throw new ModelPathError("ALREADY_EXISTS", "Destination already exists");
  }
}

// Create each missing parent segment no-follow, validating names. Returns the
// real parent dir. EEXIST passes only when the existing entry is a directory.
function mkdirpNoFollow(root: string, parentSegments: readonly string[]): string {
  let current = canonicalizeExisting(root);
  for (const segment of parentSegments) {
    validateLeafName(segment);
    const next = join(current, segment);
    let st: Stats | null = null;
    try {
      st = lstatSync(next);
    } catch {
      st = null;
    }
    if (st) {
      if (st.isSymbolicLink()) {
        throw new ModelPathError("INVALID_PATH", "Symbolic links are not allowed in filesystem paths");
      }
      if (!st.isDirectory()) {
        throw new ModelPathError("ALREADY_EXISTS", `'${segment}' exists and is not a directory`);
      }
      current = canonicalizeExisting(next);
      continue;
    }
    try {
      mkdirSync(next);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") throw mapFsError(error);
    }
    current = canonicalizeExisting(next);
    assertInsideRoot(root, current);
  }
  return current;
}

export interface FsPathMapper {
  toReal(virtual: string, intent: "read" | "write"): { realPath: string; mode: "ro" | "rw" };
  toVirtual(real: string): string | null;
}

// Virtual↔real conversion over the same binds/containment NodeFsBackend uses,
// so extensions reuse flmux's boundary instead of re-implementing it.
export function createFsPathMapper(options: CreateFsBackendOptions): FsPathMapper {
  const projectRoot = tryCanonicalizeExisting(options.projectDir) ?? resolve(options.projectDir);
  const unconfined = options.policy.unconfined;
  const binds = options.policy.binds.flatMap((b) => {
    const n = normalizeBind(b);
    return n ? [n] : [];
  });

  // Parent fully resolved (no-follow); leaf joined. Pre-rejects a leaf that's a
  // symlink or existing non-file, matching writeAtomicNoFollow's guards. The
  // no-follow create itself is the caller's (it holds the fd) — same same-call
  // TOCTOU residual as the read path.
  function realOfParentLeaf(root: string, segments: readonly string[]): string {
    if (segments.length === 0) throw new ModelPathError("INVALID_PATH", "Path is not a file");
    const leaf = segments[segments.length - 1]!;
    if (leaf === "..") throw new ModelPathError("INVALID_PATH", "Parent path segments are not allowed");
    const parent = resolveUnderRoot(root, segments.slice(0, -1));
    if (!parent.stats.isDirectory()) throw new ModelPathError("NOT_FOUND", "Path not found");
    const leafPath = join(parent.realPath, leaf);
    try {
      const st = lstatSync(leafPath);
      if (st.isSymbolicLink()) {
        throw new ModelPathError("INVALID_PATH", "Symbolic links are not allowed in filesystem paths");
      }
      if (!st.isFile()) throw new ModelPathError("INVALID_PATH", "Path is not a file");
    } catch (error) {
      if (error instanceof ModelPathError) throw error;
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT") throw mapFsError(error);
    }
    return leafPath;
  }

  return {
    toReal(virtual, intent) {
      if (unconfined) {
        const segs = parseUnconfinedPath(virtual).segments;
        const realPath =
          intent === "write" ? realOfParentLeaf(projectRoot, segs) : resolveUnderRoot(projectRoot, segs).realPath;
        return { realPath, mode: "rw" };
      }
      const parsed = parseVirtualPath(virtual, { rejectNativeAbsolute: true });
      const matched = matchBind(binds, parsed.normalized);
      if (!matched) throw new ModelPathError("NOT_FOUND", "Path not found");
      if (intent === "write" && matched.mode !== "rw") {
        throw new ModelPathError("NOT_WRITABLE", "Path is not writable");
      }
      const rel = parsed.segments.slice(matched.virtualSegments.length);
      const realPath =
        intent === "write" ? realOfParentLeaf(matched.realPath, rel) : resolveUnderRoot(matched.realPath, rel).realPath;
      return { realPath, mode: matched.mode };
    },
    toVirtual(real) {
      const canon = tryCanonicalizeExisting(real) ?? resolve(real);
      if (unconfined) {
        // projectRoot-relative `/…` so `toReal∘toVirtual` is identity (toReal
        // re-roots virtual under projectRoot). Outside projectRoot is unreachable
        // via unconfined `/fs`, so it has no virtual form → null. (Identity is for
        // canonical in-project paths; a symlinked ancestor on a non-existent leaf
        // or a `\` in a POSIX filename are virtual-scheme limits, as in toReal.)
        const rel = relativeUnder(projectRoot, canon);
        return rel === null ? null : rel ? `/${rel}` : "/";
      }
      let best: { virtual: string; rel: string; realLen: number } | null = null;
      for (const bind of binds) {
        const rel = relativeUnder(bind.realPath, canon);
        if (rel === null) continue;
        if (!best || bind.realPath.length > best.realLen) {
          best = { virtual: bind.virtual, rel, realLen: bind.realPath.length };
        }
      }
      if (!best) return null;
      return best.rel ? `${best.virtual}/${best.rel}` : best.virtual;
    }
  };
}

// Real path under `root`? Returns the "/"-joined remainder ("" if equal), else null.
function relativeUnder(root: string, target: string): string | null {
  const rel = relative(root, target);
  if (rel === "") return "";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

function matchBind(binds: readonly NormalizedBind[], virtualPath: string): NormalizedBind | undefined {
  let best: NormalizedBind | undefined;
  for (const bind of binds) {
    if (!isVirtualPrefix(virtualPath, bind.virtual)) continue;
    if (!best || bind.virtualSegments.length > best.virtualSegments.length) best = bind;
  }
  return best;
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
    const target = this.unconfined ? this.resolveUnconfined(input.path) : this.resolveConfined(input.path);
    if (!target.stats.isFile()) {
      throw new ModelPathError("INVALID_PATH", "Path is not a file");
    }
    return readUtf8File(target.realPath, input.maxBytes);
  }

  write({ path: inputPath, content }: { path: string; content: string | Uint8Array }) {
    // Gate the path (bind match + rw) before materializing content, so a bad
    // path always fails on the gate, never on a content-buffer error.
    const { root, segments } = this.resolveWritable(inputPath);
    if (segments.length === 0) {
      throw new ModelPathError("INVALID_PATH", "Path is not a file");
    }
    // Uint8Array may be a subarray view (msgpackr `bin`) — honor offset/length,
    // never the whole backing buffer.
    const buf =
      typeof content === "string"
        ? Buffer.from(content, "utf8")
        : Buffer.from(content.buffer, content.byteOffset, content.byteLength);
    return writeAtomicNoFollow(root, segments, buf);
  }

  create({ path: inputPath }: { path: string }) {
    const { root, segments } = this.resolveWritable(inputPath);
    return createNoFollow(root, segments);
  }

  mkdir({ path: inputPath }: { path: string }) {
    const { root, segments } = this.resolveWritable(inputPath);
    return mkdirNoFollow(root, segments);
  }

  delete({ path: inputPath, recursive }: { path: string; recursive?: boolean }) {
    const { root, segments } = this.resolveWritable(inputPath);
    return deleteNoFollow(root, segments, recursive ?? false);
  }

  rename({ from, to }: { from: string; to: string }) {
    const src = this.resolveWritable(from);
    const dst = this.resolveWritable(to);
    // Cross-bind move would let a rw bind reach into another bind/user dir.
    if (src.root !== dst.root) {
      throw new ModelPathError("INVALID_PATH", "Cannot move across filesystem roots");
    }
    return renameNoFollow(src.root, src.segments, dst.segments);
  }

  // Source needs read only (ro bind ok); dest needs rw. Cross-bind allowed —
  // unlike rename, copying ro→own-rw is a legitimate user action.
  copy({ from, to }: { from: string; to: string }) {
    const src = this.resolveReadableRoot(from);
    const dst = this.resolveWritable(to);
    return copyNoFollow(src.root, src.segments, dst.root, dst.segments);
  }

  // Resolve to {bind-real-root | projectRoot, rel segments} with the rw gate.
  // `root` also serves as the bind identity for cross-bind checks. Empty
  // segments (= the bind mount itself) are left for callers to reject per op.
  private resolveWritable(inputPath: string): { root: string; segments: string[] } {
    if (this.unconfined) {
      return { root: this.projectRoot, segments: parseUnconfinedPath(inputPath).segments };
    }
    const parsed = parseVirtualPath(inputPath, { rejectNativeAbsolute: true });
    const matched = this.matchBind(parsed.normalized);
    if (!matched) {
      throw new ModelPathError("NOT_FOUND", "Path not found");
    }
    if (matched.mode !== "rw") {
      throw new ModelPathError("NOT_WRITABLE", "Path is not writable");
    }
    return { root: matched.realPath, segments: parsed.segments.slice(matched.virtualSegments.length) };
  }

  // Like resolveWritable but no rw gate — read is allowed on ro and rw binds.
  private resolveReadableRoot(inputPath: string): { root: string; segments: string[] } {
    if (this.unconfined) {
      return { root: this.projectRoot, segments: parseUnconfinedPath(inputPath).segments };
    }
    const parsed = parseVirtualPath(inputPath, { rejectNativeAbsolute: true });
    const matched = this.matchBind(parsed.normalized);
    if (!matched) {
      throw new ModelPathError("NOT_FOUND", "Path not found");
    }
    return { root: matched.realPath, segments: parsed.segments.slice(matched.virtualSegments.length) };
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

    return toStatResult(
      resolveUnderRoot(matched.realPath, parsed.segments.slice(matched.virtualSegments.length)).stats
    );
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
    return matchBind(this.binds, virtualPath);
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
      mode: bind.mode,
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
      .sort((a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || a.name.localeCompare(b.name));
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

// TOCTOU on ancestor swap is the same residual class as the read path (Node lacks openat).
function writeAtomicNoFollow(root: string, segments: readonly string[], buf: Buffer): { bytesWritten: number } {
  if (segments.length === 0) {
    throw new ModelPathError("INVALID_PATH", "Path is not a file");
  }
  const parentSegments = segments.slice(0, -1);
  const leafName = segments[segments.length - 1]!;
  if (leafName === "..") {
    throw new ModelPathError("INVALID_PATH", "Parent path segments are not allowed");
  }

  const parentResolved = resolveUnderRoot(root, parentSegments);
  if (!parentResolved.stats.isDirectory()) {
    throw new ModelPathError("NOT_FOUND", "Path not found");
  }
  const parentDir = parentResolved.realPath;
  const leafPath = join(parentDir, leafName);

  // rename() replaces a leaf symlink itself (not its target); pre-check rejects that and dir clobber.
  try {
    const leafStats = lstatSync(leafPath);
    if (leafStats.isSymbolicLink()) {
      throw new ModelPathError("INVALID_PATH", "Symbolic links are not allowed in filesystem paths");
    }
    if (!leafStats.isFile()) {
      throw new ModelPathError("INVALID_PATH", "Path is not a file");
    }
  } catch (error) {
    if (error instanceof ModelPathError) throw error;
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") throw mapFsError(error);
  }

  const tmpName = `.flmux-write-${process.pid}-${randomBytes(6).toString("hex")}.${leafName}.tmp`;
  const tmpPath = join(parentDir, tmpName);
  let fd: number;
  try {
    // O_NOFOLLOW is 0 on Windows; O_EXCL carries the fresh-create guarantee on both platforms.
    fd = openSync(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o644);
  } catch (error) {
    throw mapFsError(error);
  }

  try {
    let offset = 0;
    while (offset < buf.length) {
      const written = writeSync(fd, buf, offset, buf.length - offset);
      if (written === 0) throw new Error("writeSync returned 0");
      offset += written;
    }
  } catch (error) {
    closeSync(fd);
    safeUnlink(tmpPath);
    if (error instanceof ModelPathError) throw error;
    throw mapFsError(error);
  }
  closeSync(fd);

  try {
    renameSync(tmpPath, leafPath);
  } catch (error) {
    safeUnlink(tmpPath);
    throw mapFsError(error);
  }

  return { bytesWritten: buf.length };
}

function safeUnlink(targetPath: string): void {
  try {
    unlinkSync(targetPath);
  } catch {}
}

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

// A user-typed leaf flows into a path; `validateRawPath` only blocks NUL/`..`
// and splitPathSegments splits on `/`+`\`, so a bare name like `a/b` would
// escape the row's dir. Enforce a single safe segment (also dodges Windows quirks).
function validateLeafName(name: string): void {
  if (!name || name === "." || name === "..") {
    throw new ModelPathError("INVALID_PATH", "Invalid name");
  }
  if (/[/\\\x00]/.test(name) || /[<>:"|?*\x01-\x1f]/.test(name)) {
    throw new ModelPathError("INVALID_PATH", "Name contains illegal characters");
  }
  if (name.endsWith(".") || name.endsWith(" ") || WINDOWS_RESERVED_NAME.test(name)) {
    throw new ModelPathError("INVALID_PATH", "Name is reserved or malformed");
  }
}

// Resolve the parent under `root` (no-follow) and return its real dir + leaf
// name. Rejects empty segments (= the bind root itself) and validates the leaf.
function resolveParentForLeaf(root: string, segments: readonly string[]): { parentDir: string; leaf: string } {
  if (segments.length === 0) {
    throw new ModelPathError("INVALID_PATH", "Cannot operate on the workspace root");
  }
  const leaf = segments[segments.length - 1]!;
  validateLeafName(leaf);
  const parent = resolveUnderRoot(root, segments.slice(0, -1));
  if (!parent.stats.isDirectory()) {
    throw new ModelPathError("NOT_FOUND", "Path not found");
  }
  return { parentDir: parent.realPath, leaf };
}

// No-clobber empty-file create: O_EXCL fails if the leaf exists, O_NOFOLLOW
// refuses a planted symlink. (Distinct from write, which replaces.)
function createNoFollow(root: string, segments: readonly string[]): { created: true } {
  const { parentDir, leaf } = resolveParentForLeaf(root, segments);
  let fd: number;
  try {
    fd = openSync(join(parentDir, leaf), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o644);
  } catch (error) {
    throw mapFsError(error);
  }
  closeSync(fd);
  return { created: true };
}

function mkdirNoFollow(root: string, segments: readonly string[]): { created: true } {
  const { parentDir, leaf } = resolveParentForLeaf(root, segments);
  try {
    mkdirSync(join(parentDir, leaf)); // non-recursive: parent already resolved, EEXIST if present
  } catch (error) {
    throw mapFsError(error);
  }
  return { created: true };
}

// rename within one bind (caller enforces same-root). Rejects: symlink source,
// existing destination (no clobber), and moving a dir into its own subtree.
function renameNoFollow(
  root: string,
  fromSegments: readonly string[],
  toSegments: readonly string[]
): { renamed: true } {
  const from = resolveParentForLeaf(root, fromSegments);
  const to = resolveParentForLeaf(root, toSegments);
  const fromPath = join(from.parentDir, from.leaf);
  const toPath = join(to.parentDir, to.leaf);

  const fromStats = safeLstat(fromPath);
  if (fromStats.isSymbolicLink()) {
    throw new ModelPathError("INVALID_PATH", "Symbolic links are not allowed in filesystem paths");
  }
  // No-clobber (renameSync would replace on POSIX). Symlink dest rejected; a
  // case-only rename (same canonical, non-symlink) is allowed.
  if (existsLstat(toPath)) {
    if (lstatSync(toPath).isSymbolicLink()) {
      throw new ModelPathError("INVALID_PATH", "Symbolic links are not allowed in filesystem paths");
    }
    if (canonicalizeExisting(fromPath) !== canonicalizeExisting(toPath)) {
      throw new ModelPathError("ALREADY_EXISTS", "Destination already exists");
    }
  }
  // Moving a directory into its own descendant corrupts the tree.
  if (fromStats.isDirectory()) {
    const fromCanon = canonicalizeExisting(fromPath);
    if (to.parentDir === fromCanon || relativeUnder(fromCanon, to.parentDir) !== null) {
      throw new ModelPathError("INVALID_PATH", "Cannot move a directory into itself");
    }
  }
  try {
    renameSync(fromPath, toPath);
  } catch (error) {
    throw mapFsError(error);
  }
  return { renamed: true };
}

// Recursive copy: source resolved no-follow (symlinks rejected), dest no-clobber.
// Cross-root allowed (rw gate already applied to dest by the caller).
function copyNoFollow(
  srcRoot: string,
  srcSegments: readonly string[],
  dstRoot: string,
  dstSegments: readonly string[]
): { copied: true; kind: FsEntryKind } {
  if (srcSegments.length === 0) {
    throw new ModelPathError("INVALID_PATH", "Cannot copy the workspace root");
  }
  const source = resolveUnderRoot(srcRoot, srcSegments);
  const { parentDir, leaf } = resolveParentForLeaf(dstRoot, dstSegments);
  const destPath = join(parentDir, leaf);
  if (existsLstat(destPath)) {
    throw new ModelPathError("ALREADY_EXISTS", "Destination already exists");
  }
  if (source.stats.isDirectory()) {
    if (parentDir === source.realPath || relativeUnder(source.realPath, parentDir) !== null) {
      throw new ModelPathError("INVALID_PATH", "Cannot copy a directory into itself");
    }
    try {
      copyTreeNoFollow(source.realPath, destPath);
    } catch (error) {
      // Roll back the partial tree (we created destPath; no-clobber guaranteed it was absent).
      rmSync(destPath, { recursive: true, force: true });
      throw error;
    }
    return { copied: true, kind: "dir" };
  }
  if (!source.stats.isFile()) {
    throw new ModelPathError("INVALID_PATH", "Path is not a file");
  }
  copyFileNoFollow(source.realPath, destPath);
  return { copied: true, kind: "file" };
}

// O_NOFOLLOW on both ends (parity with read/write): refuses a source or dest
// leaf swapped to a symlink, O_EXCL keeps the no-clobber guarantee.
function copyFileNoFollow(srcReal: string, destPath: string): void {
  const srcFd = openFileNoFollow(srcReal);
  let dstFd: number;
  try {
    dstFd = openSync(destPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o644);
  } catch (error) {
    closeSync(srcFd);
    throw mapFsError(error);
  }
  try {
    const buf = Buffer.allocUnsafe(65536);
    while (true) {
      const read = readSync(srcFd, buf, 0, buf.length, null);
      if (read <= 0) break;
      let off = 0;
      while (off < read) off += writeSync(dstFd, buf, off, read - off);
    }
  } catch (error) {
    closeSync(srcFd);
    closeSync(dstFd);
    safeUnlink(destPath);
    throw mapFsError(error);
  }
  closeSync(srcFd);
  closeSync(dstFd);
}

// `srcDir` is canonical; each child is lstat'd no-follow and symlinks are rejected
// (consistent with the rest of the backend). "other" types are skipped.
function copyTreeNoFollow(srcDir: string, destDir: string): void {
  try {
    mkdirSync(destDir);
  } catch (error) {
    throw mapFsError(error);
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(srcDir, { withFileTypes: true });
  } catch (error) {
    throw mapFsError(error);
  }
  for (const entry of entries) {
    const childSrc = join(srcDir, entry.name);
    const stats = safeLstat(childSrc);
    if (stats.isSymbolicLink()) {
      throw new ModelPathError("INVALID_PATH", "Symbolic links are not allowed in filesystem paths");
    }
    const childDest = join(destDir, entry.name);
    if (stats.isDirectory()) {
      copyTreeNoFollow(childSrc, childDest);
    } else if (stats.isFile()) {
      copyFileNoFollow(childSrc, childDest);
    }
  }
}

// Delete: re-lstat the leaf for the authoritative type (don't trust the caller),
// reject symlinks, and only recurse when it is genuinely a directory.
function deleteNoFollow(
  root: string,
  segments: readonly string[],
  recursive: boolean
): { deleted: true; kind: FsEntryKind } {
  if (segments.length === 0) {
    throw new ModelPathError("INVALID_PATH", "Cannot delete the workspace root");
  }
  const parent = resolveUnderRoot(root, segments.slice(0, -1));
  if (!parent.stats.isDirectory()) {
    throw new ModelPathError("NOT_FOUND", "Path not found");
  }
  const leafPath = join(parent.realPath, segments[segments.length - 1]!);
  const stats = safeLstat(leafPath);
  if (stats.isSymbolicLink()) {
    throw new ModelPathError("INVALID_PATH", "Symbolic links are not allowed in filesystem paths");
  }
  try {
    if (stats.isDirectory()) {
      if (recursive) {
        rmSync(leafPath, { recursive: true });
      } else {
        rmdirSync(leafPath); // ENOTEMPTY → NOT_EMPTY via mapFsError
      }
      return { deleted: true, kind: "dir" };
    }
    unlinkSync(leafPath);
    return { deleted: true, kind: stats.isFile() ? "file" : "other" };
  } catch (error) {
    throw mapFsError(error);
  }
}

function existsLstat(targetPath: string): boolean {
  try {
    lstatSync(targetPath);
    return true;
  } catch {
    return false;
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
    if ((b & 0x80) === 0) return buf; // ASCII → complete
    if ((b & 0xc0) === 0x80) continue; // continuation → keep walking back
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
  return (
    childPath
      .slice(parent.length + 1)
      .split("/")
      .filter(Boolean)[0] ?? null
  );
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
  // Mutation outcomes — actionable, and these messages carry no host path.
  if (code === "EEXIST") {
    return new ModelPathError("ALREADY_EXISTS", "Already exists");
  }
  if (code === "ENOTEMPTY") {
    return new ModelPathError("NOT_EMPTY", "Directory is not empty");
  }
  if (code === "EINVAL") {
    return new ModelPathError("INVALID_PATH", "Invalid path");
  }
  if (code === "EACCES" || code === "EPERM") {
    return new ModelPathError("NOT_FOUND", "Path not found");
  }
  // Generic — raw fs error messages embed the real host path (defeats /w hiding).
  return new ModelPathError("INTERNAL_ERROR", "Filesystem error");
}
