import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// Fixture root sits inside the workspace so Bun.build can resolve
// `@flmux/extension-api` via the same workspace symlinks the real build
// uses. `os.tmpdir()` is outside the workspace, so its module resolution
// can't reach the @flmux/* packages.
const FIXTURE_ROOT = resolve(import.meta.dirname, ".fixtures");
import { buildExtensionDirectory } from "../src/build";
import { formatExtensionValidationResult, resolveValidateTargets, validateExtensionDirectory } from "../src/validate";
import { FLMUX_EXTENSION_API_VERSION, validateExtensionManifest } from "../../extension-api/src/manifest";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

describe("extension manifest validation", () => {
  it("validates manifest shape and supported api version", () => {
    const result = validateExtensionManifest({
      id: "sample.cowsay",
      name: "Cowsay",
      version: "0.1.0",
      apiVersion: FLMUX_EXTENSION_API_VERSION,
      entrypoints: {
        renderer: "./index.ts"
      }
    });

    expect(result).toEqual({
      ok: true,
      manifest: {
        id: "sample.cowsay",
        name: "Cowsay",
        version: "0.1.0",
        apiVersion: FLMUX_EXTENSION_API_VERSION,
        entrypoints: {
          renderer: "./index.ts",
          cli: undefined
        },
        commands: undefined
      }
    });
  });

  it("rejects invalid manifest objects and unsafe entrypoint paths", () => {
    const result = validateExtensionManifest({
      id: "sample.cowsay",
      name: "Cowsay",
      version: "0.1.0",
      apiVersion: 999,
      entrypoints: {
        renderer: "../escape.ts"
      }
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected manifest validation to fail");
    }
    expect(result.errors).toEqual([
      `Manifest field 'apiVersion' must be ${FLMUX_EXTENSION_API_VERSION}, got 999`,
      "Manifest field 'entrypoints.renderer' must stay within the extension directory"
    ]);
  });

  it("rejects extension ids that could escape the per-extension data dir", () => {
    for (const badId of [
      "..",
      ".",
      "../auth",
      "..\\auth",
      "with/slash",
      "with\\back",
      "spaces inside",
      "carriage\rid"
    ]) {
      const result = validateExtensionManifest({
        id: badId,
        name: "Bad",
        version: "0.1.0",
        apiVersion: FLMUX_EXTENSION_API_VERSION,
        entrypoints: { renderer: "./index.ts" }
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`id '${badId}' should have been rejected`);
      expect(result.errors).toContain(
        "Manifest field 'id' must contain only ASCII letters, digits, '.', '_', '-' and not be '.' or '..'"
      );
    }
  });

  it("carries the optional shim field through command validation", () => {
    const result = validateExtensionManifest({
      id: "sample.cowsay",
      name: "Cowsay",
      version: "0.1.0",
      apiVersion: FLMUX_EXTENSION_API_VERSION,
      entrypoints: { cli: "./cli.ts" },
      commands: [{ id: "cowsay", description: "Open a cowsay pane", shim: "cowsay" }]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected validation to succeed");
    expect(result.manifest.commands).toEqual([{ id: "cowsay", description: "Open a cowsay pane", shim: "cowsay" }]);
  });

  it("rejects empty-string shim values", () => {
    const result = validateExtensionManifest({
      id: "sample.cowsay",
      name: "Cowsay",
      version: "0.1.0",
      apiVersion: FLMUX_EXTENSION_API_VERSION,
      entrypoints: { cli: "./cli.ts" },
      commands: [{ id: "cowsay", shim: "  " }]
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected validation to fail");
    expect(result.errors).toEqual(["Manifest field 'commands[0].shim' must be a non-empty string when provided"]);
  });

  it("requires command metadata when cli entrypoints are declared", () => {
    const result = validateExtensionManifest({
      id: "sample.cowsay",
      name: "Cowsay",
      version: "0.1.0",
      apiVersion: FLMUX_EXTENSION_API_VERSION,
      entrypoints: {
        cli: "./cli.ts"
      }
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected manifest validation to fail");
    }
    expect(result.errors).toEqual([
      "Manifest field 'commands' must be a non-empty array when 'entrypoints.cli' is set"
    ]);
  });
});

describe("extension-devkit validate", () => {
  it("validates a correct extension directory", async () => {
    const extensionDir = await createExtensionFixture({
      id: "sample.cowsay",
      name: "Cowsay",
      version: "0.1.0",
      apiVersion: FLMUX_EXTENSION_API_VERSION,
      rendererEntry: "./src/index.ts"
    });

    const result = await validateExtensionDirectory(extensionDir);
    expect(result.ok).toBe(true);
    expect(result.manifest?.entrypoints.renderer).toBe("./src/index.ts");
    expect(formatExtensionValidationResult(result)).toContain(`OK  ${extensionDir}`);
  });

  it("reports missing renderer entry files", async () => {
    const extensionDir = await createExtensionFixture({
      id: "sample.cowsay",
      name: "Cowsay",
      version: "0.1.0",
      apiVersion: FLMUX_EXTENSION_API_VERSION,
      rendererEntry: "./dist/index.js",
      writeRendererFile: false
    });

    const result = await validateExtensionDirectory(extensionDir);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["Renderer entrypoint does not exist: ./dist/index.js"]);
  });

  it("defaults validate targets to the current working directory", () => {
    expect(resolveValidateTargets([])).toEqual([process.cwd()]);
    expect(resolveValidateTargets(["a", "b"])).toEqual(["a", "b"]);
  });

  it("builds dist runtime artifacts and rewrites manifest entrypoints to js", async () => {
    const extensionDir = await createExtensionFixture({
      id: "sample.cowsay",
      name: "Cowsay",
      version: "0.1.0",
      apiVersion: FLMUX_EXTENSION_API_VERSION,
      rendererEntry: "./src/index.ts",
      extraFiles: [
        {
          path: "./src/lib/helper.ts",
          contents: 'export const label = "helper";\n'
        },
        {
          path: "./src/template.html",
          contents: "<section>template</section>"
        }
      ],
      rendererContents: [
        'import { label } from "./lib/helper.ts";',
        'export const assetUrl = new URL("./template.html", import.meta.url).href;',
        "export default { label };",
        ""
      ].join("\n")
    });

    const result = await buildExtensionDirectory(extensionDir);
    expect(result.ok).toBe(true);

    const manifest = JSON.parse(await Bun.file(join(extensionDir, "dist", "manifest.json")).text());
    expect(manifest).toEqual({
      id: "sample.cowsay",
      name: "Cowsay",
      version: "0.1.0",
      apiVersion: FLMUX_EXTENSION_API_VERSION,
      entrypoints: {
        renderer: "src/index.js"
      }
    });

    const builtRenderer = await Bun.file(join(extensionDir, "dist", "src", "index.js")).text();
    // Bun.build inlines relative source imports and rewrites URL-imported
    // asset references to remain relative to import.meta.url; the asset
    // itself is copied through as a sidecar so the runtime URL resolves.
    expect(builtRenderer).toContain('label = "helper"');
    expect(builtRenderer).toContain('new URL("./template.html", import.meta.url)');

    expect(await Bun.file(join(extensionDir, "dist", "src", "template.html")).text()).toBe(
      "<section>template</section>"
    );
  });
});

async function createExtensionFixture(input: {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  rendererEntry: string;
  writeRendererFile?: boolean;
  rendererContents?: string;
  extraFiles?: Array<{ path: string; contents: string }>;
}) {
  await mkdir(FIXTURE_ROOT, { recursive: true });
  const extensionDir = await mkdtemp(join(FIXTURE_ROOT, "ext-"));
  tempDirs.push(extensionDir);

  await writeFile(
    join(extensionDir, "manifest.json"),
    JSON.stringify(
      {
        id: input.id,
        name: input.name,
        version: input.version,
        apiVersion: input.apiVersion,
        entrypoints: {
          renderer: input.rendererEntry
        }
      },
      null,
      2
    ),
    "utf8"
  );

  if (input.writeRendererFile !== false) {
    const rendererEntryPath = join(extensionDir, input.rendererEntry);
    await mkdir(dirname(rendererEntryPath), { recursive: true });
    await writeFile(rendererEntryPath, input.rendererContents ?? "export default {};\n", "utf8");
  }

  for (const file of input.extraFiles ?? []) {
    const filePath = join(extensionDir, file.path);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, file.contents, "utf8");
  }

  return extensionDir;
}
