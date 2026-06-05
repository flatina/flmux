import { createConfig } from "@flatina/confkit";
import type { ExtensionConfig, ExtensionConfigBuilder, ExtensionServerInitContext } from "@flmux/extension-api";

/**
 * Host side of `ExtensionServerInitContext.loadConfig` — binds the extension's
 * narrow builder contract (extension-api config.ts) to the host's confkit.
 * `cwd: dataDir` makes relative file paths resolve against the extension's
 * data dir; watcher disposal is registered with the host (extensions never
 * see `dispose`).
 */
export function createExtensionConfigLoader(options: {
  extId: string;
  dataDir: string;
  registerDispose(fn: () => void): void;
}): ExtensionServerInitContext["loadConfig"] {
  return async function loadConfig<T>(
    build: (builder: ExtensionConfigBuilder<T>) => void
  ): Promise<ExtensionConfig<T>> {
    const builder = createConfig<T>({
      cwd: options.dataDir,
      onReloadError: (error) => {
        console.warn(`[flmux] extension '${options.extId}' config reload rejected (kept previous):`, error);
      }
    });
    // The extension contract is a structural subset of confkit's builder
    // (validate's extra ctx param and option supersets are compatible).
    build(builder as unknown as ExtensionConfigBuilder<T>);
    const config = await builder.load();
    options.registerDispose(() => config.dispose());
    return config as unknown as ExtensionConfig<T>;
  };
}
