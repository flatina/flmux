export const FLMUX_EXTENSION_API_VERSION = 2;

export interface ExtensionManifestEntrypoints {
  renderer?: string;
  cli?: string;
}

export interface ExtensionManifestCommand {
  id: string;
  description?: string;
}

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  entrypoints: ExtensionManifestEntrypoints;
  commands?: ExtensionManifestCommand[];
}

export type ExtensionManifestValidationResult =
  | { ok: true; manifest: ExtensionManifest }
  | { ok: false; errors: string[] };

export function validateExtensionManifest(value: unknown): ExtensionManifestValidationResult {
  if (!isPlainObject(value)) {
    return { ok: false, errors: ["Manifest must be a JSON object"] };
  }

  const errors: string[] = [];
  const id = asNonEmptyString(value.id);
  const name = asNonEmptyString(value.name);
  const version = asNonEmptyString(value.version);
  const apiVersion = value.apiVersion;
  const entrypoints = value.entrypoints;
  const commands = value.commands;

  if (!id) {
    errors.push("Manifest field 'id' must be a non-empty string");
  }
  if (!name) {
    errors.push("Manifest field 'name' must be a non-empty string");
  }
  if (!version) {
    errors.push("Manifest field 'version' must be a non-empty string");
  }
  if (apiVersion !== FLMUX_EXTENSION_API_VERSION) {
    errors.push(
      `Manifest field 'apiVersion' must be ${FLMUX_EXTENSION_API_VERSION}, got ${typeof apiVersion === "number" ? apiVersion : String(apiVersion)}`
    );
  }
  if (!isPlainObject(entrypoints)) {
    errors.push("Manifest field 'entrypoints' must be an object");
  }

  const renderer = isPlainObject(entrypoints) ? entrypoints.renderer : undefined;
  const cli = isPlainObject(entrypoints) ? entrypoints.cli : undefined;
  const rendererPath = validateManifestEntrypointPath(renderer, "entrypoints.renderer");
  const cliPath = validateManifestEntrypointPath(cli, "entrypoints.cli");
  const commandsResult = validateManifestCommands(commands, Boolean(cli));

  if (rendererPath) {
    errors.push(rendererPath);
  }
  if (cliPath) {
    errors.push(cliPath);
  }
  if (!commandsResult.ok) {
    errors.push(...commandsResult.errors);
  }

  if (!renderer && !cli) {
    errors.push("Manifest must define at least one of 'entrypoints.renderer' or 'entrypoints.cli'");
  }

  if (errors.length > 0 || !id || !name || !version || !isPlainObject(entrypoints)) {
    return { ok: false, errors };
  }

    return {
      ok: true,
      manifest: {
        id,
        name,
      version,
        apiVersion: FLMUX_EXTENSION_API_VERSION,
        entrypoints: {
          renderer: typeof renderer === "string" ? renderer.trim() : undefined,
          cli: typeof cli === "string" ? cli.trim() : undefined
        },
        commands: commandsResult.ok ? commandsResult.commands : undefined
      }
    };
}

function validateManifestEntrypointPath(value: unknown, label: string) {
  if (value === undefined) {
    return null;
  }

  if (typeof value !== "string" || !value.trim()) {
    return `Manifest field '${label}' must be a non-empty string when provided`;
  }

  const normalized = value.trim().replace(/\\/g, "/");
  if (/^[A-Za-z]:/.test(normalized) || normalized.startsWith("/") || normalized.startsWith("//")) {
    return `Manifest field '${label}' must be a relative path`;
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) {
    return `Manifest field '${label}' must stay within the extension directory`;
  }

  return null;
}

function asNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validateManifestCommands(value: unknown, hasCliEntrypoint: boolean) {
  if (value === undefined) {
    return hasCliEntrypoint
      ? { ok: false as const, errors: ["Manifest field 'commands' must be a non-empty array when 'entrypoints.cli' is set"] }
      : { ok: true as const, commands: undefined };
  }

  if (!hasCliEntrypoint) {
    return { ok: false as const, errors: ["Manifest field 'commands' requires 'entrypoints.cli'"] };
  }

  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false as const, errors: ["Manifest field 'commands' must be a non-empty array when 'entrypoints.cli' is set"] };
  }

  const commands: ExtensionManifestCommand[] = [];
  const errors: string[] = [];
  const seenIds = new Set<string>();

  value.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      errors.push(`Manifest field 'commands[${index}]' must be an object`);
      return;
    }

    const id = asNonEmptyString(entry.id);
    const description =
      entry.description === undefined
        ? undefined
        : asNonEmptyString(entry.description);

    if (!id) {
      errors.push(`Manifest field 'commands[${index}].id' must be a non-empty string`);
      return;
    }
    if (entry.description !== undefined && !description) {
      errors.push(`Manifest field 'commands[${index}].description' must be a non-empty string when provided`);
      return;
    }
    if (seenIds.has(id)) {
      errors.push(`Manifest field 'commands' contains duplicate command id '${id}'`);
      return;
    }

    seenIds.add(id);
    commands.push(description ? { id, description } : { id });
  });

  return errors.length > 0
    ? { ok: false as const, errors }
    : { ok: true as const, commands };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
