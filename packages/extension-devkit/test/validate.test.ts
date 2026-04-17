import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildExtensionDirectory } from "../src/build";
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
    expect(result.errors).toEqual([
      "Renderer entrypoint does not exist: ./dist/index.js"
    ]);
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
        'import { defineExtension } from "@flmux/extension-api";',
        'import { label } from "./lib/helper.ts";',
        'export const assetUrl = new URL("./template.html", import.meta.url).href;',
        "export default defineExtension({ label });",
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
    // Bare specifier is preserved; browser resolves via <script type="importmap"> in index.html,
    // server resolves via Bun workspace. Only relative .ts imports get rewritten to .js.
    expect(builtRenderer).toContain('from "@flmux/extension-api"');
    expect(builtRenderer).toContain('from "./lib/helper.js"');
    expect(builtRenderer).toContain('new URL("./template.html", import.meta.url)');

    expect(await Bun.file(join(extensionDir, "dist", "src", "lib", "helper.js")).text()).toContain(
      'export const label = "helper";'
    );
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
    await writeFile(rendererEntryPath, input.rendererContents ?? "export default {};\n", "utf8");
  }

  for (const file of input.extraFiles ?? []) {
    const filePath = join(extensionDir, file.path);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, file.contents, "utf8");
  }

  return extensionDir;
}
