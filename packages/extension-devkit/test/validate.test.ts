import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  formatExtensionValidationResult,
  resolveValidateTargets,
  validateExtensionDirectory
} from "../src/validate";
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
        }
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
      "Manifest field 'apiVersion' must be 1, got 999",
      "Manifest field 'entrypoints.renderer' must stay within the extension directory"
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
    expect(result.errors).toEqual([
      "Renderer entrypoint does not exist: ./dist/index.js"
    ]);
  });

  it("defaults validate targets to the current working directory", () => {
    expect(resolveValidateTargets([])).toEqual([process.cwd()]);
    expect(resolveValidateTargets(["a", "b"])).toEqual(["a", "b"]);
  });
});

async function createExtensionFixture(input: {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  rendererEntry: string;
  writeRendererFile?: boolean;
}) {
  const extensionDir = await mkdtemp(join(tmpdir(), "flmux-devkit-"));
  tempDirs.push(extensionDir);

  await writeFile(
    join(extensionDir, "manifest.json"),
    JSON.stringify({
      id: input.id,
      name: input.name,
      version: input.version,
      apiVersion: input.apiVersion,
      entrypoints: {
        renderer: input.rendererEntry
      }
    }, null, 2),
    "utf8"
  );

  if (input.writeRendererFile !== false) {
    const rendererEntryPath = join(extensionDir, input.rendererEntry);
    await mkdir(dirname(rendererEntryPath), { recursive: true });
    await writeFile(rendererEntryPath, "export default {};\n", "utf8");
  }

  return extensionDir;
}
