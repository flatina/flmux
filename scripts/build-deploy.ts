#!/usr/bin/env bun
// Build a flmux deployment package for Windows / macOS / Linux.
//
// Usage:
//   bun scripts/build-deploy.ts [--target=<plat>] [--out <dir>]
//
//   --target=win|mac|linux  Cross-compile target. Default = host platform.
//
// Layout produced (per-platform):
//   <out>/
//     flmux[.exe]                   compiled standalone (bun runtime + bundled main/ptyd/cli;
//                                    self-dispatch via FLMUX_INTERNAL_MODE env)
//     flmux.{bat,sh}                launcher (sets FLMUX_EXTENSIONS_ROOT)
//     libBuniteNative.{dll,dylib,so}  bunite native
//     (win) libBuniteNativeWebView2.dll, WebView2Loader.dll, process_helper.exe
//     renderer/                     Bun.build output (HTML entry + CSS graph)
//     extensions/<name>/dist/       expanded extension dist (sample.* skipped)

import { $ } from "bun";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";

// Concise by default (often Claude-run) — `--verbose` / FLMUX_DEPLOY_VERBOSE=1
// restores per-phase narration. Warnings and errors always print.
const VERBOSE = Bun.argv.includes("--verbose") || process.env.FLMUX_DEPLOY_VERBOSE === "1";
const step = (m: string) => {
  if (VERBOSE) console.log(m);
};

type Target = "win" | "mac" | "linux" | "linux-arm64";
interface TargetSpec {
  bunTarget: string;
  exeName: string;
  nativePkg: string;
  nativeFiles: string[];
  launcherName: string;
  launcherContent: string;
}

const TARGETS: Record<Target, TargetSpec> = {
  win: {
    bunTarget: "bun-windows-x64",
    exeName: "flmux.exe",
    nativePkg: "bunite-native-win-x64",
    nativeFiles: ["libBuniteNative.dll", "libBuniteNativeWebView2.dll", "WebView2Loader.dll", "process_helper.exe"],
    launcherName: "flmux.bat",
    launcherContent: `@echo off\r\nset FLMUX_EXTENSIONS_ROOT=%~dp0extensions\r\n"%~dp0flmux.exe" %*\r\n`
  },
  mac: {
    bunTarget: "bun-darwin-arm64",
    exeName: "flmux",
    nativePkg: "bunite-native-mac-arm64",
    nativeFiles: ["libBuniteNative.dylib"],
    launcherName: "flmux.sh",
    launcherContent: `#!/usr/bin/env sh\nexport FLMUX_EXTENSIONS_ROOT="$(dirname "$0")/extensions"\nexec "$(dirname "$0")/flmux" "$@"\n`
  },
  linux: {
    bunTarget: "bun-linux-x64",
    exeName: "flmux",
    nativePkg: "bunite-native-linux-x64",
    nativeFiles: ["libBuniteNative.so"],
    launcherName: "flmux.sh",
    launcherContent: `#!/usr/bin/env sh\nexport FLMUX_EXTENSIONS_ROOT="$(dirname "$0")/extensions"\nexec "$(dirname "$0")/flmux" "$@"\n`
  },
  "linux-arm64": {
    bunTarget: "bun-linux-arm64",
    exeName: "flmux",
    nativePkg: "bunite-native-linux-arm64",
    nativeFiles: ["libBuniteNative.so"],
    launcherName: "flmux.sh",
    launcherContent: `#!/usr/bin/env sh\nexport FLMUX_EXTENSIONS_ROOT="$(dirname "$0")/extensions"\nexec "$(dirname "$0")/flmux" "$@"\n`
  }
};

// Web-only: skips bunite native (web mode never instantiates AppRuntime) and
// runs `--web`. Terminals use Bun.Terminal (built into the runtime, all-arch) —
// no native pty lib to bundle.
function webLauncher(): string {
  return [
    "#!/usr/bin/env sh",
    'dir="$(cd "$(dirname "$0")" && pwd)"',
    'export FLMUX_EXTENSIONS_ROOT="$dir/extensions"',
    'exec "$dir/flmux" --web "$@"',
    ""
  ].join("\n");
}

function hostTarget(): Target {
  switch (process.platform) {
    case "win32":
      return "win";
    case "darwin":
      return "mac";
    case "linux":
      return "linux";
    default:
      throw new Error(`Unsupported host: ${process.platform}`);
  }
}

const args = Bun.argv.slice(2);
const targetArg = args.find((a) => a.startsWith("--target="))?.slice("--target=".length);
const target: Target = (targetArg as Target) ?? hostTarget();
if (!(target in TARGETS)) {
  console.error(`Invalid --target=${targetArg}; expected win|mac|linux`);
  process.exit(1);
}
const spec = TARGETS[target];
const webOnly = args.includes("--web");

const outArgIdx = args.indexOf("--out");
const repoRoot = resolve(dirname(Bun.main), "..");
const appDir = join(repoRoot, "packages/app");
const outDir =
  outArgIdx > -1 && args[outArgIdx + 1] ? resolve(args[outArgIdx + 1]!) : join(repoRoot, `dist/deploy-${target}`);

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

step(`Target: ${target} (${spec.bunTarget})`);
step(`Out:    ${outDir}\n`);

// 1. Resolve native package (download tarball if cross-target's native isn't installed locally).
// Web-only skips bunite native — web mode never instantiates AppRuntime.
const nativeDir = webOnly ? null : await ensureNativePackage(spec.nativePkg);

// 2. Compile entrypoint → exe
step(`1. compile entrypoint → ${spec.exeName}`);
const exePath = join(outDir, spec.exeName);
await $`bun build src/entrypoint.ts --compile --minify --define __FLMUX_COMPILED__=true --target=${spec.bunTarget} --outfile ${exePath}`.cwd(
  appDir
);

if (target === "win") {
  // CUI → GUI (suppress console on launch)
  const pe = readFileSync(exePath);
  if (pe[0] === 0x4d && pe[1] === 0x5a) {
    const peOffset = pe.readUInt32LE(0x3c);
    if (
      peOffset + 0x5e <= pe.length &&
      pe[peOffset] === 0x50 &&
      pe[peOffset + 1] === 0x45 &&
      pe.readUInt16LE(peOffset + 0x5c) === 3
    ) {
      pe.writeUInt16LE(2, peOffset + 0x5c);
      writeFileSync(exePath, pe);
    }
  }
} else {
  chmodSync(exePath, 0o755);
}

// 3. Renderer (Bun.build — HTML entry + CSS graph)
step("\n2. renderer");
// Quiet the renderer build chatter unless verbose; a failure is still caught by
// the existsSync(rendererOut) check below.
await (VERBOSE ? $`bun run build:renderer`.cwd(appDir) : $`bun run build:renderer`.cwd(appDir).quiet());
const rendererOut = join(appDir, "dist/renderer");
if (!existsSync(rendererOut)) {
  console.error(`renderer output not found at ${rendererOut}`);
  process.exit(1);
}
cpSync(rendererOut, join(outDir, "renderer"), { recursive: true });

// 4. Native files (web-only: skip bunite native; terminals use built-in Bun.Terminal)
if (webOnly) {
  step("\n3. native (web — bunite native skipped; terminals use Bun.Terminal)");
} else {
  step(`\n3. native (${spec.nativePkg})`);
  for (const f of spec.nativeFiles) {
    const src = join(nativeDir!, f);
    if (!existsSync(src)) {
      console.error(`  missing: ${src}`);
      process.exit(1);
    }
    cpSync(src, join(outDir, f));
  }
}

// Newest mtime across a set of files/dirs (recursive, files only). Flags a
// stale extension dist (build inputs newer than the last build) before ship.
function newestMtimeMs(paths: string[]): number {
  let newest = 0;
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const rel of new Bun.Glob("**/*").scanSync({ cwd: p })) {
        try {
          const m = statSync(join(p, rel)).mtimeMs;
          if (m > newest) newest = m;
        } catch {
          /* file vanished mid-scan */
        }
      }
    } else if (st.mtimeMs > newest) {
      newest = st.mtimeMs;
    }
  }
  return newest;
}

// 5. Extensions (expanded dist; sample.* skipped)
step("\n4. extensions");
const extOutDir = join(outDir, "extensions");
mkdirSync(extOutDir, { recursive: true });
const srcExtDir = join(repoRoot, "extensions");
let copied = 0;
for (const entry of readdirSync(srcExtDir, { withFileTypes: true })) {
  if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
  const manifestPath = join(srcExtDir, entry.name, "manifest.json");
  if (!existsSync(manifestPath)) continue;
  let manifest: { id?: string; devOnly?: unknown };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    continue;
  }
  if (typeof manifest.id !== "string") continue;
  if (manifest.devOnly === true) {
    step(`(skip)   ${entry.name}`);
    continue;
  }
  const distSrc = join(srcExtDir, entry.name, "dist");
  if (!existsSync(distSrc)) {
    console.warn(`  (no dist) ${entry.name}`);
    continue;
  }
  // Stale-dist warning: build inputs (src / package.json / manifest) newer than
  // the built dist = a forgotten `bun run build:prod` in the extension's repo.
  // Ship anyway (operator may have reason), but flag it loudly.
  const extDir = join(srcExtDir, entry.name);
  const inputMs = newestMtimeMs([join(extDir, "src"), join(extDir, "package.json"), manifestPath]);
  const distMs = newestMtimeMs([distSrc]);
  if (inputMs > distMs) {
    console.warn(
      `  ⚠ STALE  ${entry.name}: build inputs newer than dist ` +
        `(${new Date(inputMs).toISOString()} > ${new Date(distMs).toISOString()}) — run \`bun run build:prod\` in its repo`
    );
  }
  cpSync(distSrc, join(extOutDir, entry.name, "dist"), { recursive: true });
  step(`OK       ${entry.name} (${manifest.id})`);
  copied += 1;
}
if (copied === 0 && !webOnly) {
  console.error("\nno private extensions copied — aborting");
  process.exit(1);
}
console.log(`   extensions: ${copied} copied`);

// 6. Launcher
step("\n5. launcher");
const launcherPath = join(outDir, spec.launcherName);
writeFileSync(launcherPath, webOnly ? webLauncher() : spec.launcherContent);
if (target !== "win") chmodSync(launcherPath, 0o755);

// 7. Size report
step("");
function sizeOf(p: string): number {
  const s = statSync(p);
  if (s.isFile()) return s.size;
  let t = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) t += sizeOf(join(p, e.name));
  return t;
}
const mb = (b: number) => (b / 1024 / 1024).toFixed(1);
let total = 0;
for (const e of readdirSync(outDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  const sz = sizeOf(join(outDir, e.name));
  total += sz;
  step(`${e.name}${e.isDirectory() ? "/" : ""}  ${mb(sz)} MB`);
}
step(`\n  Total: ${mb(total)} MB`);
console.log(`\nDeploy ready: ${outDir}`);
console.log(`Run on target: ${spec.launcherName}`);

// Native package resolution: installed deps first, fallback to npm registry tarball
// (cross-target case — bun skips os-mismatched optional deps even when declared).
async function ensureNativePackage(pkg: string): Promise<string> {
  const installed = join(repoRoot, "node_modules", ".bun", "node_modules", pkg);
  if (existsSync(join(installed, spec.nativeFiles[0]!))) return installed;

  const candidate2 = join(repoRoot, "packages/app/node_modules", pkg);
  if (existsSync(join(candidate2, spec.nativeFiles[0]!))) return candidate2;

  step(`fetching ${pkg} (cross-target — not installed locally)`);
  const cacheDir = join(repoRoot, "dist/.native-cache", pkg);
  const distInfo = await $`bun pm view ${pkg} dist`.text();
  const tarballMatch = distInfo.match(/"tarball":\s*"([^"]+)"/);
  if (!tarballMatch) throw new Error(`Cannot resolve tarball URL for ${pkg}`);
  const tarballUrl = tarballMatch[1]!;

  rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });
  const tgzPath = join(cacheDir, "pkg.tgz");
  const response = await fetch(tarballUrl);
  if (!response.ok) throw new Error(`Fetch ${tarballUrl} failed: ${response.status}`);
  await Bun.write(tgzPath, response);

  // bunite native tarballs put files at archive root under `package/`
  await $`tar -xzf ${tgzPath} -C ${cacheDir}`.quiet();
  return join(cacheDir, "package");
}
