import { mkdirSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BunPlugin } from "bun";
import { info } from "../shared/logger";

/**
 * Build the renderer for web (non-Electrobun) environments.
 * Swaps electrobun-rpc → ws-rpc via build plugin.
 */
export async function buildWebRenderer(projectRoot: string, outputDir: string): Promise<void> {
  mkdirSync(outputDir, { recursive: true });

  const wsRpcPath = resolve(projectRoot, "src/renderer/lib/ws-rpc.ts");

  const swapRpcPlugin: BunPlugin = {
    name: "swap-electrobun-rpc",
    setup(build) {
      // Redirect host-rpc.ts (which re-exports electrobun-rpc) to ws-rpc.ts
      build.onResolve({ filter: /\/host-rpc$/ }, () => ({ path: wsRpcPath }));
      // Also catch direct electrobun-rpc imports
      build.onResolve({ filter: /\/electrobun-rpc$/ }, () => ({ path: wsRpcPath }));
      // Stub electrobun/view — should never be reached but just in case
      build.onResolve({ filter: /^electrobun\// }, () => ({ path: wsRpcPath, external: true }));
    }
  };

  const result = await Bun.build({
    entrypoints: [join(projectRoot, "src/renderer/main.ts")],
    outdir: outputDir,
    target: "browser",
    minify: false,
    sourcemap: "inline",
    plugins: [swapRpcPlugin]
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error("Web renderer build failed");
  }

  // Copy index.html
  copyFileSync(
    join(projectRoot, "src/renderer/index.html"),
    join(outputDir, "index.html")
  );

  info("web", `renderer built to ${outputDir}`);
}
