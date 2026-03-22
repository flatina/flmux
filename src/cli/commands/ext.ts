import { defineCommand } from "citty";
import { discoverAllExtensions } from "../../main/extension-discovery";
import {
  disableExtension,
  enableExtension,
  loadExtensionSettings,
  saveExtensionSettings
} from "../../shared/extension-settings";
import { output } from "./_utils";

const list = defineCommand({
  meta: { name: "list", description: "List discovered extensions" },
  run: () => {
    const extensions = discoverAllExtensions(process.env.FLMUX_ROOT ?? process.cwd());
    output(
      extensions.map((ext) => ({
        id: ext.manifest.id,
        name: ext.manifest.name,
        version: ext.manifest.version,
        embedded: ext.embedded,
        disabled: ext.disabled,
        path: ext.path
      }))
    );
  }
});

const enable = defineCommand({
  meta: { name: "enable", description: "Enable an extension" },
  args: {
    id: { type: "positional", description: "Extension ID", required: true }
  },
  run: ({ args }) => {
    const settings = loadExtensionSettings();
    const updated = enableExtension(settings, args.id);
    saveExtensionSettings(updated);
    console.log(`Enabled: ${args.id}`);
  }
});

const disable = defineCommand({
  meta: { name: "disable", description: "Disable an extension" },
  args: {
    id: { type: "positional", description: "Extension ID", required: true }
  },
  run: ({ args }) => {
    const settings = loadExtensionSettings();
    const updated = disableExtension(settings, args.id);
    saveExtensionSettings(updated);
    console.log(`Disabled: ${args.id}`);
  }
});

export default defineCommand({
  meta: { name: "ext", description: "Manage extensions" },
  subCommands: { list, enable, disable }
});
